-- All application writes go through narrow RPCs. Apply this migration atomically.
-- The private schema must NOT be included in Supabase's exposed API schemas.

create schema if not exists private;

create type public.app_role as enum ('manager', 'executor');
create type public.task_status as enum ('new', 'in_progress', 'review', 'accepted', 'rework');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete restrict,
  full_name text not null check (full_name ~ '[^[:space:]]' and char_length(full_name) <= 200),
  role public.app_role not null
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (name ~ '[^[:space:]]' and char_length(name) <= 200),
  address text not null check (address ~ '[^[:space:]]' and char_length(address) <= 500),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  title text not null check (title ~ '[^[:space:]]' and char_length(title) <= 200),
  description text not null default '' check (char_length(description) <= 10000),
  assignee_id uuid not null references public.profiles (id) on delete restrict,
  status public.task_status not null default 'new',
  author_id uuid not null references public.profiles (id) on delete restrict,
  author_name text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.task_status_history (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id) on delete restrict,
  from_status public.task_status,
  to_status public.task_status not null,
  actor_id uuid not null references public.profiles (id) on delete restrict,
  actor_name text not null,
  created_at timestamptz not null default now(),
  comment text check (comment is null or (comment ~ '[^[:space:]]' and char_length(comment) <= 10000)),
  constraint history_initial_or_transition check (
    (from_status is null and to_status = 'new')
    or (from_status is not null and (
      (from_status = 'new' and to_status = 'in_progress')
      or (from_status = 'in_progress' and to_status = 'review')
      or (from_status = 'review' and to_status in ('accepted', 'rework'))
      or (from_status = 'rework' and to_status = 'in_progress')
    ))
  ),
  constraint history_rework_comment check (to_status <> 'rework' or comment is not null)
);

create index tasks_project_id_idx on public.tasks (project_id);
create index tasks_assignee_id_idx on public.tasks (assignee_id);
create index tasks_author_id_idx on public.tasks (author_id);
create index tasks_active_assignee_project_idx on public.tasks (assignee_id, project_id) where deleted_at is null;
create index history_task_created_idx on public.task_status_history (task_id, created_at, id);
create index history_actor_id_idx on public.task_status_history (actor_id);

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.tasks enable row level security;
alter table public.task_status_history enable row level security;

-- The caller's role comes from a protected table, never user-editable metadata.
-- Definer lookup avoids profiles policies recursively querying themselves.
create function private.current_app_role()
returns public.app_role
language sql stable security definer
set search_path = ''
as $$
  select p.role
  from public.profiles as p
  where (select auth.uid()) is not null and p.id = (select auth.uid());
$$;

create policy profiles_read on public.profiles
for select to authenticated
using (id = (select auth.uid()) or (select private.current_app_role()) = 'manager');

-- Deliberately no projects lookup here. Project archive also archives its tasks
-- in the same transaction, keeping the policies' dependency graph acyclic.
create policy tasks_read on public.tasks
for select to authenticated
using (
  deleted_at is null
  and (
    (select private.current_app_role()) = 'manager'
    or ((select private.current_app_role()) = 'executor' and assignee_id = (select auth.uid()))
  )
);

create policy projects_read on public.projects
for select to authenticated
using (
  deleted_at is null
  and (
    (select private.current_app_role()) = 'manager'
    or exists (
      select 1 from public.tasks as t
      where t.project_id = projects.id
        and t.deleted_at is null
        and t.assignee_id = (select auth.uid())
    )
  )
);

create policy history_read on public.task_status_history
for select to authenticated
using (
  exists (select 1 from public.tasks as t where t.id = task_status_history.task_id)
);

create function private.require_manager()
returns public.profiles
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_actor public.profiles;
begin
  select * into v_actor from public.profiles where id = auth.uid();
  if not found or v_actor.role <> 'manager' then
    raise exception using errcode = '42501', message = 'Требуются права постановщика';
  end if;
  return v_actor;
end;
$$;

create function private.create_project(p_name text, p_address text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_project public.projects;
begin
  perform private.require_manager();
  if p_name is null or p_name !~ '[^[:space:]]' or char_length(p_name) > 200
     or p_address is null or p_address !~ '[^[:space:]]' or char_length(p_address) > 500 then
    raise exception using errcode = '22023', message = 'Укажите название (до 200 символов) и адрес (до 500 символов)';
  end if;
  insert into public.projects (name, address)
  values (btrim(p_name), btrim(p_address)) returning * into v_project;
  return to_jsonb(v_project);
end;
$$;

create function private.update_project(p_project_id uuid, p_name text, p_address text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_project public.projects;
begin
  perform private.require_manager();
  if p_name is null or p_name !~ '[^[:space:]]' or char_length(p_name) > 200
     or p_address is null or p_address !~ '[^[:space:]]' or char_length(p_address) > 500 then
    raise exception using errcode = '22023', message = 'Укажите название (до 200 символов) и адрес (до 500 символов)';
  end if;
  update public.projects set name = btrim(p_name), address = btrim(p_address)
  where id = p_project_id and deleted_at is null returning * into v_project;
  if not found then
    raise exception using errcode = 'P0002', message = 'Объект не найден или удалён';
  end if;
  return to_jsonb(v_project);
end;
$$;

create function private.archive_project(p_project_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_project public.projects;
  v_deleted_at timestamptz := now();
begin
  perform private.require_manager();
  -- Every writer adding a task to this project takes this same parent lock.
  select * into v_project from public.projects
  where id = p_project_id and deleted_at is null for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Объект не найден или удалён';
  end if;
  update public.tasks set deleted_at = v_deleted_at
  where project_id = p_project_id and deleted_at is null;
  update public.projects set deleted_at = v_deleted_at
  where id = p_project_id returning * into v_project;
  return to_jsonb(v_project);
end;
$$;

create function private.create_task(p_project_id uuid, p_title text, p_description text, p_assignee_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor public.profiles;
  v_task public.tasks;
begin
  v_actor := private.require_manager();
  if p_title is null or p_title !~ '[^[:space:]]' or char_length(p_title) > 200
     or char_length(coalesce(p_description, '')) > 10000 then
    raise exception using errcode = '22023', message = 'Укажите название (до 200 символов); описание — до 10000 символов';
  end if;
  perform 1 from public.projects where id = p_project_id and deleted_at is null for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Объект не найден или удалён';
  end if;
  perform 1 from public.profiles where id = p_assignee_id and role = 'executor';
  if not found then
    raise exception using errcode = '22023', message = 'Выберите пользователя с ролью исполнителя';
  end if;
  insert into public.tasks (project_id, title, description, assignee_id, author_id, author_name)
  values (p_project_id, btrim(p_title), coalesce(p_description, ''), p_assignee_id, v_actor.id, v_actor.full_name)
  returning * into v_task;
  insert into public.task_status_history (task_id, from_status, to_status, actor_id, actor_name)
  values (v_task.id, null, 'new', v_actor.id, v_actor.full_name);
  return to_jsonb(v_task);
end;
$$;

create function private.update_task(p_task_id uuid, p_project_id uuid, p_title text, p_description text, p_assignee_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_task public.tasks;
begin
  perform private.require_manager();
  if p_title is null or p_title !~ '[^[:space:]]' or char_length(p_title) > 200
     or char_length(coalesce(p_description, '')) > 10000 then
    raise exception using errcode = '22023', message = 'Укажите название (до 200 символов); описание — до 10000 символов';
  end if;
  -- Lock destination before task: no task can be moved into an archived project.
  -- A concurrent archive of the source either archives it first (we fail), or
  -- rechecks project_id after this move and skips the task that moved away.
  perform 1 from public.projects where id = p_project_id and deleted_at is null for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Объект не найден или удалён';
  end if;
  select * into v_task from public.tasks where id = p_task_id and deleted_at is null for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Задача не найдена или удалена';
  end if;
  perform 1 from public.profiles where id = p_assignee_id and role = 'executor';
  if not found then
    raise exception using errcode = '22023', message = 'Выберите пользователя с ролью исполнителя';
  end if;
  update public.tasks
  set project_id = p_project_id, title = btrim(p_title), description = coalesce(p_description, ''), assignee_id = p_assignee_id
  where id = p_task_id returning * into v_task;
  -- Metadata edits, reassignment, and moves never change status or audit fields.
  return to_jsonb(v_task);
end;
$$;

create function private.archive_task(p_task_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_task public.tasks;
begin
  perform private.require_manager();
  update public.tasks set deleted_at = now()
  where id = p_task_id and deleted_at is null returning * into v_task;
  if not found then
    raise exception using errcode = 'P0002', message = 'Задача не найдена или удалена';
  end if;
  return to_jsonb(v_task);
end;
$$;

create function private.transition_task(
  p_task_id uuid,
  p_expected_status public.task_status,
  p_new_status public.task_status,
  p_comment text default null
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor public.profiles;
  v_task public.tasks;
  v_from public.task_status;
  v_comment text := nullif(btrim(p_comment), '');
begin
  select * into v_actor from public.profiles where id = auth.uid();
  if not found then
    raise exception using errcode = '42501', message = 'Нет доступа к системе';
  end if;
  -- Include authorization in the locked lookup, so foreign/missing IDs are
  -- indistinguishable to an executor and never reveal another task's status.
  select * into v_task from public.tasks
  where id = p_task_id and deleted_at is null
    and (v_actor.role = 'manager' or assignee_id = v_actor.id)
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Задача не найдена или недоступна';
  end if;
  if p_expected_status is null or p_new_status is null then
    raise exception using errcode = '22023', message = 'Укажите текущий и новый статус';
  end if;
  if v_task.status is distinct from p_expected_status then
    raise exception using errcode = 'P0001', message = 'Статус уже изменился. Обновите карточку задачи';
  end if;
  if not (
    (v_actor.role = 'executor' and v_task.assignee_id = v_actor.id and (
      (v_task.status = 'new' and p_new_status = 'in_progress')
      or (v_task.status = 'in_progress' and p_new_status = 'review')
      or (v_task.status = 'rework' and p_new_status = 'in_progress')
    ))
    or (v_actor.role = 'manager' and v_task.status = 'review' and p_new_status in ('accepted', 'rework'))
  ) then
    raise exception using errcode = '22023', message = 'Этот переход статуса недоступен';
  end if;
  if v_comment is not null and v_comment !~ '[^[:space:]]' then
    v_comment := null;
  end if;
  if p_new_status = 'rework' and v_comment is null then
    raise exception using errcode = '22023', message = 'Для возврата на доработку нужен комментарий';
  end if;
  if char_length(v_comment) > 10000 then
    raise exception using errcode = '22023', message = 'Комментарий — до 10000 символов';
  end if;
  v_from := v_task.status;
  update public.tasks set status = p_new_status
  where id = p_task_id returning * into v_task;
  insert into public.task_status_history (task_id, from_status, to_status, actor_id, actor_name, comment)
  values (v_task.id, v_from, v_task.status, v_actor.id, v_actor.full_name, v_comment);
  return to_jsonb(v_task);
end;
$$;

-- Exposed wrappers do not run with elevated privileges. Every private writer
-- independently derives the caller from auth.uid() and validates authorization.
create function public.create_project(p_name text, p_address text)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.create_project(p_name, p_address); $$;

create function public.update_project(p_project_id uuid, p_name text, p_address text)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.update_project(p_project_id, p_name, p_address); $$;

create function public.archive_project(p_project_id uuid)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.archive_project(p_project_id); $$;

create function public.create_task(p_project_id uuid, p_title text, p_description text, p_assignee_id uuid)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.create_task(p_project_id, p_title, p_description, p_assignee_id); $$;

create function public.update_task(p_task_id uuid, p_project_id uuid, p_title text, p_description text, p_assignee_id uuid)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.update_task(p_task_id, p_project_id, p_title, p_description, p_assignee_id); $$;

create function public.archive_task(p_task_id uuid)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.archive_task(p_task_id); $$;

create function public.transition_task(
  p_task_id uuid,
  p_expected_status public.task_status,
  p_new_status public.task_status,
  p_comment text default null
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.transition_task(p_task_id, p_expected_status, p_new_status, p_comment); $$;

-- Do not rely on project-specific Supabase default grants. No API role can
-- write task status/history directly, even if it crafts a manual REST request.
revoke all on table public.profiles, public.projects, public.tasks, public.task_status_history
from public, anon, authenticated, service_role;
grant select on table public.profiles, public.projects, public.tasks, public.task_status_history
to authenticated, service_role;
-- Provisioning only: a trusted administrator creates the fixed test profiles.
grant insert, update, delete on table public.profiles to service_role;

revoke all on schema private from public, anon, authenticated, service_role;
grant usage on schema private to authenticated;
revoke all on function private.current_app_role() from public, anon, authenticated, service_role;
revoke all on function private.require_manager() from public, anon, authenticated, service_role;
revoke all on function private.create_project(text, text) from public, anon, authenticated, service_role;
revoke all on function private.update_project(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function private.archive_project(uuid) from public, anon, authenticated, service_role;
revoke all on function private.create_task(uuid, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function private.update_task(uuid, uuid, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function private.archive_task(uuid) from public, anon, authenticated, service_role;
revoke all on function private.transition_task(uuid, public.task_status, public.task_status, text) from public, anon, authenticated, service_role;
grant execute on function private.current_app_role() to authenticated;
grant execute on function private.create_project(text, text) to authenticated;
grant execute on function private.update_project(uuid, text, text) to authenticated;
grant execute on function private.archive_project(uuid) to authenticated;
grant execute on function private.create_task(uuid, text, text, uuid) to authenticated;
grant execute on function private.update_task(uuid, uuid, text, text, uuid) to authenticated;
grant execute on function private.archive_task(uuid) to authenticated;
grant execute on function private.transition_task(uuid, public.task_status, public.task_status, text) to authenticated;

revoke all on function public.create_project(text, text) from public, anon, authenticated, service_role;
revoke all on function public.update_project(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.archive_project(uuid) from public, anon, authenticated, service_role;
revoke all on function public.create_task(uuid, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.update_task(uuid, uuid, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.archive_task(uuid) from public, anon, authenticated, service_role;
revoke all on function public.transition_task(uuid, public.task_status, public.task_status, text) from public, anon, authenticated, service_role;

grant execute on function public.create_project(text, text) to authenticated;
grant execute on function public.update_project(uuid, text, text) to authenticated;
grant execute on function public.archive_project(uuid) to authenticated;
grant execute on function public.create_task(uuid, text, text, uuid) to authenticated;
grant execute on function public.update_task(uuid, uuid, text, text, uuid) to authenticated;
grant execute on function public.archive_task(uuid) to authenticated;
grant execute on function public.transition_task(uuid, public.task_status, public.task_status, text) to authenticated;

comment on table public.task_status_history is 'Append-only status audit. Written only by validated task RPCs; retained after soft deletion.';
comment on column public.tasks.author_name is 'Database-sourced author name snapshot, not client-editable.';
comment on column public.task_status_history.actor_name is 'Database-sourced actor name snapshot at the time of the transition.';

notify pgrst, 'reload schema';
