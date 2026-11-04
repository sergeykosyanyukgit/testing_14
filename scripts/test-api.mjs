import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

// All authorization assertions use ordinary user sessions. The administrative
// client is used only to verify that archived data/history remain stored.
const projectUrl = required('SUPABASE_URL').replace(/\/$/, '');
const publicKey = required('SUPABASE_PUBLISHABLE_KEY');
const options = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } };
const clients = {};
const users = {};
const fixtures = [];
const statuses = ['new', 'in_progress', 'review', 'accepted', 'rework'];
const runId = randomUUID().slice(0, 8);
let assertions = 0;
let checks = 0;

function required(name) {
  if (!process.env[name]) throw new Error(`Missing ${name}; run with node --env-file=.env.`);
  return process.env[name];
}

function must(result, operation) {
  if (result.error) throw new Error(`${operation} failed (${result.error.code ?? result.error.status ?? 'API error'}).`);
  return result.data;
}

function ok(value, message) {
  assert.ok(value, message);
  assertions += 1;
}

function equal(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  assertions += 1;
}

function denied(result, message) {
  ok(Boolean(result.error), message);
}

async function rpc(client, name, args) {
  const data = must(await client.rpc(name, args), name);
  return Array.isArray(data) ? data[0] : data;
}

async function group(label, action) {
  await action();
  checks += 1;
  console.log(`PASS ${label}`);
}

async function createProject(label, client = clients.manager1) {
  const project = await rpc(client, 'create_project', { p_name: `[API ${runId}] ${label}`, p_address: 'Тестовый адрес, 1' });
  ok(Boolean(project?.id), 'create_project must return its row');
  fixtures.push(project.id);
  return project;
}

async function createTask(projectId, assigneeId = users.executor1.id, client = clients.manager1, label = 'Проверка API') {
  const task = await rpc(client, 'create_task', {
    p_project_id: projectId,
    p_title: `[API ${runId}] ${label}`,
    p_description: 'Временная задача проверки. После проверки удаляется из рабочих списков.',
    p_assignee_id: assigneeId,
  });
  ok(Boolean(task?.id), 'create_task must return its row');
  return task;
}

async function readTask(taskId, client = clients.manager1) {
  return must(await client.from('tasks').select('*').eq('id', taskId).single(), 'read task');
}

async function history(taskId, client = clients.manager1) {
  return must(await client.from('task_status_history').select('*').eq('task_id', taskId).order('created_at'), 'read history');
}

async function transition(client, taskId, from, to, comment = null) {
  return rpc(client, 'transition_task', { p_task_id: taskId, p_expected_status: from, p_new_status: to, p_comment: comment });
}

async function taskInStatus(projectId, target) {
  const task = await createTask(projectId);
  if (target !== 'new') await transition(clients.executor1, task.id, 'new', 'in_progress');
  if (['review', 'accepted', 'rework'].includes(target)) await transition(clients.executor1, task.id, 'in_progress', 'review');
  if (target === 'accepted') await transition(clients.manager2, task.id, 'review', 'accepted');
  if (target === 'rework') await transition(clients.manager1, task.id, 'review', 'rework', 'Требуется повторная проверка узла.');
  return readTask(task.id);
}

async function main() {
  const credentials = JSON.parse(await readFile('.demo-credentials.json', 'utf8'));
  ok(credentials.projectUrl === projectUrl && credentials.complete, 'Seed must be complete for this project');
  for (const user of credentials.users) {
    const client = createClient(projectUrl, publicKey, options);
    const data = must(await client.auth.signInWithPassword({ email: user.email, password: user.password }), 'sign in test user');
    ok(data.user.id === user.id, 'Test user ID must match saved credentials');
    users[user.key] = user;
    clients[user.key] = client;
  }
  clients.anon = createClient(projectUrl, publicKey, options);
  const admin = createClient(projectUrl, required('SUPABASE_SECRET_KEY'), options);
  const shared = await createProject('Общий объект');
  const onlyA = await createProject('Только исполнитель А');
  const onlyB = await createProject('Только исполнитель Б');
  const sharedA = await createTask(shared.id);
  const sharedB = await createTask(shared.id, users.executor2.id, clients.manager2);
  const a = await createTask(onlyA.id);
  const b = await createTask(onlyB.id, users.executor2.id);

  await group('two managers can create/edit; authors and initial history are server-generated', async () => {
    const edited = await rpc(clients.manager2, 'update_project', { p_project_id: shared.id, p_name: `[API ${runId}] Общий объект — проверено`, p_address: 'Тестовый адрес, 2' });
    ok(edited?.id === shared.id, 'Second manager can edit the first manager project');
    equal(sharedB.author_id, users.manager2.id, 'Author must be the actual current user');
    equal(sharedB.author_name, users.manager2.full_name, 'Author name must come from the protected profile');
    equal(sharedB.status, 'new', 'Initial status must be new');
    ok(Number.isFinite(Date.parse(sharedB.created_at)), 'Creation timestamp must be a server timestamp');
    const events = await history(sharedB.id);
    equal(events.length, 1, 'Creation must produce exactly one history event');
    equal(events[0].from_status, null, 'Initial transition must start at null');
    equal(events[0].to_status, 'new', 'Initial transition must end at new');
    equal(events[0].actor_id, users.manager2.id, 'History actor must be the actual manager');
  });

  await group('RLS isolates tasks, parent objects, nested relations and history', async () => {
    for (const [ownKey, foreignTask, ownProject, foreignProject] of [
      ['executor1', sharedB, onlyA, onlyB],
      ['executor2', sharedA, onlyB, onlyA],
    ]) {
      const client = clients[ownKey];
      const foreign = must(await client.from('tasks').select('*').eq('id', foreignTask.id), 'read foreign task');
      equal(foreign, [], 'Known foreign task UUID must not reveal data');
      equal(await history(foreignTask.id, client), [], 'Foreign history must not be readable');
      const ownProjects = must(await client.from('projects').select('id').in('id', [shared.id, ownProject.id, foreignProject.id]), 'read visible projects');
      equal(ownProjects.map((project) => project.id).sort(), [shared.id, ownProject.id].sort(), 'Only assigned projects may be visible');
      const joined = must(await client.from('projects').select('id,tasks(id,assignee_id)').eq('id', shared.id).single(), 'nested project read');
      equal(joined.tasks.length, 1, 'A shared project must not reveal the other executor task');
      equal(joined.tasks[0].assignee_id, users[ownKey].id, 'Nested task must belong to the current executor');
      const ownProfiles = must(await client.from('profiles').select('id,role'), 'read profiles');
      equal(ownProfiles.map((profile) => profile.id), [users[ownKey].id], 'Executor may read only their own protected profile');
    }
    for (const table of ['profiles', 'projects', 'tasks', 'task_status_history']) {
      const response = await clients.anon.from(table).select('*');
      ok(Boolean(response.error) || response.data?.length === 0, 'Anonymous API must not expose CRM data');
    }
    const managers = must(await clients.manager1.from('profiles').select('id,role'), 'manager profiles');
    ok(managers.length >= 4, 'Manager can list the seed users');
  });

  await group('complete allowed status workflow produces one immutable event per action', async () => {
    const task = await createTask(shared.id);
    const steps = [
      ['executor1', 'new', 'in_progress', null],
      ['executor1', 'in_progress', 'review', null],
      ['manager2', 'review', 'rework', 'Устранить замечания по узлу.'],
      ['executor1', 'rework', 'in_progress', null],
      ['executor1', 'in_progress', 'review', null],
      ['manager1', 'review', 'accepted', 'Работа принята.'],
    ];
    for (const [actor, from, to, comment] of steps) {
      await transition(clients[actor], task.id, from, to, comment);
    }
    const events = await history(task.id);
    equal(events.length, steps.length + 1, 'Every transition must create one history event');
    for (const [actor, from, to, comment] of steps) {
      const event = events.find((entry) => entry.from_status === from && entry.to_status === to && entry.actor_id === users[actor].id);
      ok(Boolean(event), 'Expected transition event must be present');
      equal(event.actor_name, users[actor].full_name, 'Actor name must be a server-generated snapshot');
      if (comment) equal(event.comment, comment, 'Transition comment must be preserved');
    }
    equal((await readTask(task.id)).status, 'accepted', 'Final state must be accepted');
  });

  await group('every other status/role combination is denied through direct RPC', async () => {
    const allowed = {
      new: { executor1: ['in_progress'] },
      in_progress: { executor1: ['review'] },
      review: { manager1: ['accepted', 'rework'], manager2: ['accepted', 'rework'] },
      accepted: {},
      rework: { executor1: ['in_progress'] },
    };
    for (const from of statuses) {
      const task = await taskInStatus(onlyA.id, from);
      const before = (await history(task.id)).length;
      for (const actor of ['manager1', 'manager2', 'executor1', 'executor2', 'anon']) {
        for (const to of statuses) {
          if (allowed[from][actor]?.includes(to)) continue;
          denied(await clients[actor].rpc('transition_task', {
            p_task_id: task.id, p_expected_status: from, p_new_status: to, p_comment: 'Проверка запрета перехода.',
          }), `Forbidden transition ${from} -> ${to} must fail for ${actor}`);
        }
      }
      equal((await readTask(task.id)).status, from, 'Rejected transitions must preserve current status');
      equal((await history(task.id)).length, before, 'Rejected transitions must not append history');
    }
  });

  await group('rework requires a non-whitespace comment and conflicts preserve history', async () => {
    const task = await taskInStatus(onlyA.id, 'review');
    const before = (await history(task.id)).length;
    for (const comment of [null, '', '   ', '\t\n']) {
      denied(await clients.manager1.rpc('transition_task', {
        p_task_id: task.id, p_expected_status: 'review', p_new_status: 'rework', p_comment: comment,
      }), 'Empty/whitespace comments must be rejected');
    }
    denied(await clients.manager1.rpc('transition_task', {
      p_task_id: task.id, p_expected_status: 'new', p_new_status: 'accepted', p_comment: null,
    }), 'A stale expected_status must be rejected');
    equal((await readTask(task.id)).status, 'review', 'Failed requests must preserve task status');
    equal((await history(task.id)).length, before, 'Failed requests must preserve history');
  });

  await group('direct table writes, author spoofing and history changes are denied', async () => {
    const event = (await history(a.id))[0];
    for (const actor of ['manager1', 'executor1']) {
      const client = clients[actor];
      denied(await client.from('tasks').update({ status: 'accepted' }).eq('id', a.id), 'Direct status PATCH must be forbidden');
      denied(await client.from('tasks').update({ title: 'Подмена', author_id: users.executor2.id, created_at: '2000-01-01T00:00:00Z' }).eq('id', a.id), 'Direct task metadata PATCH must be forbidden');
      denied(await client.from('tasks').insert({ project_id: onlyA.id, title: 'Подмена автора', description: '', assignee_id: users.executor1.id, status: 'accepted', author_id: users.executor2.id, author_name: 'Подмена', created_at: '2000-01-01T00:00:00Z' }), 'Direct task INSERT must be forbidden');
      denied(await client.from('tasks').delete().eq('id', a.id), 'Direct task DELETE must be forbidden');
      denied(await client.from('task_status_history').insert({ id: randomUUID(), task_id: a.id, from_status: 'new', to_status: 'accepted', actor_id: users.executor2.id, actor_name: 'Подмена', created_at: '2000-01-01T00:00:00Z', comment: 'Подмена' }), 'History INSERT must be forbidden');
      denied(await client.from('task_status_history').update({ actor_id: users.executor2.id, comment: 'Подмена' }).eq('id', event.id), 'History UPDATE must be forbidden');
      denied(await client.from('task_status_history').delete().eq('id', event.id), 'History DELETE must be forbidden');
      denied(await client.from('projects').update({ name: 'Подмена' }).eq('id', onlyA.id), 'Direct project UPDATE must be forbidden');
    }
    denied(await clients.manager1.rpc('create_task', {
      p_project_id: onlyA.id, p_title: 'Подмена автора', p_description: '', p_assignee_id: users.executor1.id,
      p_author_id: users.executor2.id, p_status: 'accepted',
    }), 'RPC must not accept author/status parameters from the client');
    equal((await readTask(a.id)).author_id, users.manager1.id, 'Author must remain unchanged');
    equal((await history(a.id)).length, 1, 'History must remain unchanged after forgery attempts');
  });

  await group('executors cannot create/edit/delete or escalate through editable metadata', async () => {
    denied(await clients.executor1.rpc('create_project', { p_name: 'Запрещено', p_address: 'Адрес' }), 'Executor cannot create projects');
    denied(await clients.executor1.rpc('update_project', { p_project_id: onlyA.id, p_name: 'Запрещено', p_address: 'Адрес' }), 'Executor cannot edit projects');
    denied(await clients.executor1.rpc('archive_project', { p_project_id: onlyA.id }), 'Executor cannot archive projects');
    denied(await clients.executor1.rpc('create_task', { p_project_id: onlyA.id, p_title: 'Запрещено', p_description: '', p_assignee_id: users.executor1.id }), 'Executor cannot create tasks');
    denied(await clients.executor1.rpc('update_task', { p_task_id: a.id, p_project_id: onlyA.id, p_title: 'Запрещено', p_description: '', p_assignee_id: users.executor1.id }), 'Executor cannot edit tasks');
    denied(await clients.executor1.rpc('archive_task', { p_task_id: a.id }), 'Executor cannot archive tasks');
    denied(await clients.executor1.from('profiles').update({ role: 'manager' }).eq('id', users.executor1.id), 'Executor cannot modify their protected role');
    must(await clients.executor1.auth.updateUser({ data: { role: 'manager' } }), 'set editable metadata');
    denied(await clients.executor1.rpc('create_project', { p_name: 'Запрещено', p_address: 'Адрес' }), 'Editable metadata must not elevate the database role');
    equal(must(await clients.executor1.from('profiles').select('role').eq('id', users.executor1.id).single(), 'read protected role').role, 'executor', 'Protected role must stay executor');
    must(await clients.executor1.auth.updateUser({ data: { role: null } }), 'clear test metadata');
  });

  await group('database validates required fields and the assignee role', async () => {
    denied(await clients.manager1.rpc('create_project', { p_name: '   ', p_address: 'Адрес' }), 'Blank project name must fail');
    denied(await clients.manager1.rpc('create_project', { p_name: 'Объект', p_address: '   ' }), 'Blank project address must fail');
    denied(await clients.manager1.rpc('create_task', { p_project_id: onlyA.id, p_title: '   ', p_description: '', p_assignee_id: users.executor1.id }), 'Blank task title must fail');
    denied(await clients.manager1.rpc('create_task', { p_project_id: onlyA.id, p_title: 'Задача', p_description: '', p_assignee_id: users.manager1.id }), 'A manager cannot be assigned as executor');
  });

  await group('reassignment preserves status and immediately revokes the previous executor', async () => {
    const task = await taskInStatus(shared.id, 'in_progress');
    const eventsBefore = (await history(task.id)).length;
    await rpc(clients.manager2, 'update_task', {
      p_task_id: task.id, p_project_id: shared.id, p_title: task.title, p_description: task.description, p_assignee_id: users.executor2.id,
    });
    equal((await readTask(task.id)).status, 'in_progress', 'Reassignment must preserve the status');
    equal(must(await clients.executor1.from('tasks').select('*').eq('id', task.id), 'previous executor read'), [], 'Previous executor must lose task access');
    equal(await history(task.id, clients.executor1), [], 'Previous executor must lose history access');
    denied(await clients.executor1.rpc('transition_task', { p_task_id: task.id, p_expected_status: 'in_progress', p_new_status: 'review', p_comment: null }), 'Previous executor cannot change status');
    equal((await history(task.id, clients.executor2)).length, eventsBefore, 'New executor can read the entire existing history');
    await transition(clients.executor2, task.id, 'in_progress', 'review');
    equal((await readTask(task.id)).status, 'review', 'New executor can continue the same workflow');
  });

  await group('simultaneous requests with one expected status append exactly one event', async () => {
    const task = await createTask(shared.id);
    const args = { p_task_id: task.id, p_expected_status: 'new', p_new_status: 'in_progress', p_comment: null };
    const responses = await Promise.all([clients.executor1.rpc('transition_task', args), clients.executor1.rpc('transition_task', args)]);
    equal(responses.filter((response) => !response.error).length, 1, 'Exactly one concurrent transition must succeed');
    equal((await history(task.id)).length, 2, 'A race must append exactly one event after creation');
  });

  await group('soft task deletion hides data while retaining the immutable history', async () => {
    const before = await history(a.id);
    await rpc(clients.manager2, 'archive_task', { p_task_id: a.id });
    for (const client of [clients.manager1, clients.executor1]) {
      equal(must(await client.from('tasks').select('*').eq('id', a.id), 'read archived task'), [], 'Archived task must disappear from API reads');
      equal(await history(a.id, client), [], 'Archived task history must not be exposed through ordinary API reads');
    }
    const storedTask = must(await admin.from('tasks').select('deleted_at').eq('id', a.id).single(), 'inspect stored archived task');
    ok(Boolean(storedTask.deleted_at), 'Task must remain stored with deleted_at');
    equal(must(await admin.from('task_status_history').select('id').eq('task_id', a.id), 'inspect retained history').length, before.length, 'Deleting a task must not delete its history');
  });

  await group('parent deletion archives all children, retains history and rejects new work', async () => {
    const before = await history(b.id);
    await rpc(clients.manager1, 'archive_project', { p_project_id: onlyB.id });
    equal(must(await clients.manager1.from('projects').select('*').eq('id', onlyB.id), 'read archived project'), [], 'Archived project must disappear');
    equal(must(await clients.executor2.from('tasks').select('*').eq('id', b.id), 'read child of archived project'), [], 'Child tasks must disappear');
    const stored = must(await admin.from('tasks').select('deleted_at').eq('id', b.id).single(), 'inspect archived child');
    ok(Boolean(stored.deleted_at), 'Project deletion must archive its child tasks');
    equal(must(await admin.from('task_status_history').select('id').eq('task_id', b.id), 'inspect child history').length, before.length, 'Project deletion must preserve child history');
    denied(await clients.manager1.rpc('create_task', { p_project_id: onlyB.id, p_title: 'После удаления', p_description: '', p_assignee_id: users.executor1.id }), 'Creating work in an archived project must fail');
    denied(await clients.manager1.rpc('update_task', { p_task_id: sharedA.id, p_project_id: onlyB.id, p_title: sharedA.title, p_description: sharedA.description, p_assignee_id: users.executor1.id }), 'Moving work into an archived project must fail');
  });

  await group('concurrent parent deletion and task creation cannot leave an active child', async () => {
    const project = await createProject('Проверка конкурентного удаления');
    const responses = await Promise.all([
      clients.manager1.rpc('archive_project', { p_project_id: project.id }),
      clients.manager2.rpc('create_task', { p_project_id: project.id, p_title: 'Конкурентное создание', p_description: '', p_assignee_id: users.executor1.id }),
    ]);
    ok(!responses[0].error, 'Parent archival must succeed');
    const children = must(await admin.from('tasks').select('id,deleted_at').eq('project_id', project.id), 'inspect concurrent children');
    ok(children.every((task) => task.deleted_at !== null), 'Every stored child of an archived project must also be archived');
    equal(must(await clients.manager1.from('tasks').select('id').eq('project_id', project.id), 'read concurrent children'), [], 'No active child may remain exposed');
  });

  // GET settings is read-only. The independent signUp API check belongs to the
  // deployment verification because it could create a user if misconfigured.
  await group('open signup and anonymous sign-in are disabled in hosted Auth settings', async () => {
    const response = await fetch(`${projectUrl}/auth/v1/settings`, { headers: { apikey: publicKey } });
    ok(response.ok, 'Auth settings endpoint must be reachable');
    const settings = await response.json();
    equal(settings.disable_signup, true, 'Hosted signup must be disabled');
    equal(settings.external?.anonymous_users ?? false, false, 'Anonymous sign-in must be disabled');
  });

  console.log(`API verification passed: ${checks} groups, ${assertions} assertions. No privileged client was used for authorization assertions.`);
}

async function cleanup() {
  if (!clients.manager1) return;
  for (const projectId of fixtures) {
    const visible = await clients.manager1.from('projects').select('id').eq('id', projectId);
    if (!visible.error && visible.data?.length) {
      const result = await clients.manager1.rpc('archive_project', { p_project_id: projectId });
      if (result.error) {
        console.error(`Fixture cleanup failed (${result.error.code ?? 'API error'}).`);
        process.exitCode = 1;
      }
    }
  }
}

main().catch((error) => {
  // Never dump full Supabase responses, sessions or credentials to the console.
  console.error(`API verification failed: ${error.message}`);
  process.exitCode = 1;
}).finally(cleanup);
