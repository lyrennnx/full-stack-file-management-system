-- Apply after 0000_filebox.sql in a Supabase project.
-- Server mutations use a private privileged PostgreSQL connection. Browser roles
-- have read-only, RLS-filtered metadata access and no access to internal secrets.
BEGIN;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.file_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.storage_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pending_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.share_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.users, public.folders, public.files, public.file_shares,
 public.storage_usage, public.activity_logs, public.sessions, public.pending_uploads,
 public.share_grants, public.rate_limits FROM anon, authenticated;

-- SECURITY DEFINER helpers avoid recursive RLS and inherit folder permissions.
-- The requesting identity is always auth.uid(), never a caller-supplied UUID.
CREATE OR REPLACE FUNCTION public.filebox_can_access_folder(target uuid, require_editor boolean DEFAULT false)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 WITH RECURSIVE lineage AS (
  SELECT id, parent_folder_id, user_id, deleted_at, ARRAY[id] AS visited
  FROM public.folders WHERE id = target
  UNION ALL
  SELECT f.id, f.parent_folder_id, f.user_id, f.deleted_at, l.visited || f.id
  FROM public.folders f JOIN lineage l ON f.id = l.parent_folder_id
  WHERE NOT f.id = ANY(l.visited) AND cardinality(l.visited) < 100
 )
 SELECT EXISTS(SELECT 1 FROM lineage WHERE id = target AND user_id = auth.uid())
 OR (NOT EXISTS(SELECT 1 FROM lineage WHERE deleted_at IS NOT NULL)
  AND EXISTS(
   SELECT 1 FROM public.file_shares s JOIN lineage l ON l.id = s.folder_id
   WHERE s.recipient_id = auth.uid() AND s.revoked_at IS NULL
    AND (s.expires_at IS NULL OR s.expires_at > now())
    AND (NOT require_editor OR s.permission = 'editor')
  ));
$$;

CREATE OR REPLACE FUNCTION public.filebox_can_access_file(target uuid, require_editor boolean DEFAULT false)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 SELECT EXISTS(
  SELECT 1 FROM public.files f WHERE f.id = target AND (
   f.user_id = auth.uid()
   OR (f.deleted_at IS NULL AND (
    public.filebox_can_access_folder(f.folder_id, require_editor)
    OR EXISTS(
     SELECT 1 FROM public.file_shares s WHERE s.file_id = f.id
      AND s.recipient_id = auth.uid() AND s.revoked_at IS NULL
      AND (s.expires_at IS NULL OR s.expires_at > now())
      AND (NOT require_editor OR s.permission = 'editor')
    )
   ))
  )
 );
$$;
REVOKE ALL ON FUNCTION public.filebox_can_access_folder(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.filebox_can_access_file(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.filebox_can_access_folder(uuid, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.filebox_can_access_file(uuid, boolean) TO authenticated, service_role;

CREATE POLICY "users_read_self" ON public.users FOR SELECT TO authenticated USING (id = auth.uid());
CREATE POLICY "folders_read_authorized" ON public.folders FOR SELECT TO authenticated USING (public.filebox_can_access_folder(id));
CREATE POLICY "files_read_authorized" ON public.files FOR SELECT TO authenticated USING (public.filebox_can_access_file(id));
CREATE POLICY "shares_read_participants" ON public.file_shares FOR SELECT TO authenticated USING (owner_id = auth.uid() OR recipient_id = auth.uid());
CREATE POLICY "usage_read_self" ON public.storage_usage FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "activity_read_self" ON public.activity_logs FOR SELECT TO authenticated USING (user_id = auth.uid());

GRANT SELECT (id, email, full_name, avatar_url, is_guest, auth_provider, created_at, updated_at) ON public.users TO authenticated;
GRANT SELECT ON public.folders, public.files, public.storage_usage, public.activity_logs TO authenticated;
GRANT SELECT (id, file_id, folder_id, owner_id, recipient_id, permission, expires_at, created_at, revoked_at) ON public.file_shares TO authenticated;
-- No browser grants for password hashes, token hashes, sessions, pending uploads,
-- share grants, or rate-limit data. No direct metadata mutation grants.
GRANT ALL ON public.users, public.folders, public.files, public.file_shares,
 public.storage_usage, public.activity_logs, public.sessions, public.pending_uploads,
 public.share_grants, public.rate_limits TO service_role;

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('filebox', 'filebox', false, 5368709120)
ON CONFLICT (id) DO UPDATE SET public = false;

CREATE POLICY "filebox_private_authorized_read" ON storage.objects
FOR SELECT TO authenticated USING (
 bucket_id = 'filebox' AND EXISTS (
  SELECT 1 FROM public.files f WHERE f.storage_path = storage.objects.name
   AND f.deleted_at IS NULL AND public.filebox_can_access_file(f.id)
 )
);
-- Intentionally no broad authenticated INSERT/UPDATE/DELETE policies.
-- The API issues object-scoped signed upload capabilities and performs authorized
-- copies/deletions using its server-only service-role key. Public share URLs are
-- validated by the API before issuing a <=60-second signed download.
COMMIT;
