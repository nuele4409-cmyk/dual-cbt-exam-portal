-- ─────────────────────────────────────────────────────────────────────────────
-- Inside OAU! CBT — Admin RPC functions
-- Run once in: Supabase Dashboard → SQL Editor
--
-- These SECURITY DEFINER functions let the admin toggle student access from
-- the admin panel, bypassing normal RLS restrictions.  They verify the caller
-- is an admin before executing any privileged action.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── admin_set_access ──────────────────────────────────────────────────────────
-- Grants or revokes has_post_utme_access for any student.
-- Called by the admin panel "Grant / Revoke" buttons.

create or replace function public.admin_set_access(
    target_id  uuid,
    new_access boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_is_admin  boolean := false;
    v_caller_email text;
    _admin_email constant text := 'nuele4409@gmail.com';
begin
    -- Check is_admin flag on caller's profile
    select coalesce(is_admin, false)
    into   v_is_admin
    from   public.profiles
    where  id = auth.uid();

    -- Fallback: check caller's auth email
    if not v_is_admin then
        select lower(email)
        into   v_caller_email
        from   auth.users
        where  id = auth.uid();

        v_is_admin := (v_caller_email = lower(_admin_email));
    end if;

    if not v_is_admin then
        raise exception 'Access denied: admin only';
    end if;

    update public.profiles
    set    has_post_utme_access = new_access
    where  id = target_id;
end;
$$;

grant execute on function public.admin_set_access(uuid, boolean) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Done.  The password feature uses the /api/set-password Vercel function
-- (api/set-password.js) — no SQL needed for that.
-- ─────────────────────────────────────────────────────────────────────────────
