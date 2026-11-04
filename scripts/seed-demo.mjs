import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

// This administrative script is run locally. It is never imported by the app.
const projectUrl = required('SUPABASE_URL').replace(/\/$/, '');
const publicKey = required('SUPABASE_PUBLISHABLE_KEY');
const secretKey = required('SUPABASE_SECRET_KEY');
const credentialsPath = resolve('.demo-credentials.json');
const clientOptions = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } };
const admin = createClient(projectUrl, secretKey, clientOptions);

function required(name) {
  if (!process.env[name]) throw new Error(`Missing ${name}; run with node --env-file=.env.`);
  return process.env[name];
}

function must(result, operation) {
  if (result.error) throw new Error(`${operation} failed (${result.error.code ?? result.error.status ?? 'API error'}).`);
  return result.data;
}

async function rpc(client, name, args) {
  const data = must(await client.rpc(name, args), name);
  return Array.isArray(data) ? data[0] : data;
}

let state;

async function save() {
  await writeFile(credentialsPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

async function loadState() {
  try {
    const existing = JSON.parse(await readFile(credentialsPath, 'utf8'));
    if (existing.format !== 1 || existing.projectUrl !== projectUrl) {
      throw new Error('The credentials file belongs to a different seed format or project.');
    }
    return existing;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {
      format: 1,
      projectUrl,
      createdAt: new Date().toISOString(),
      complete: false,
      users: [
        { key: 'manager1', email: 'manager1@demo.work-search.ru', full_name: 'Алексей Морозов', role: 'manager' },
        { key: 'manager2', email: 'manager2@demo.work-search.ru', full_name: 'Мария Волкова', role: 'manager' },
        { key: 'executor1', email: 'executor1@demo.work-search.ru', full_name: 'Иван Петров', role: 'executor' },
        { key: 'executor2', email: 'executor2@demo.work-search.ru', full_name: 'Сергей Кузнецов', role: 'executor' },
      ].map((user) => ({ ...user, password: `Crm!${randomBytes(18).toString('base64url')}` })),
      projects: {},
      tasks: {},
    };
  }
}

async function findUserByEmail(email) {
  for (let page = 1; page <= 100; page += 1) {
    const data = must(await admin.auth.admin.listUsers({ page, perPage: 100 }), 'list seed users');
    const found = data.users.find((user) => user.email?.toLowerCase() === email.toLowerCase());
    if (found) return found;
    if (data.users.length < 100) return null;
  }
  throw new Error('Too many users to safely locate a seed account.');
}

async function main() {
  state = await loadState();
  if (state.complete) {
    console.log('Demo seed already complete: 4 users, 3 projects, 8 tasks. Credentials preserved.');
    return;
  }
  // Save passwords before the first API mutation, so a retry never resets them.
  await save();
  const clients = {};
  for (const user of state.users) {
    if (!user.id) {
      let account = await findUserByEmail(user.email);
      if (!account) {
        account = must(await admin.auth.admin.createUser({
          email: user.email,
          password: user.password,
          email_confirm: true,
          user_metadata: { full_name: user.full_name },
        }), 'create seed user').user;
      }
      user.id = account.id;
      await save();
    }
    const client = createClient(projectUrl, publicKey, clientOptions);
    must(await client.auth.signInWithPassword({ email: user.email, password: user.password }), 'sign in seed user');
    clients[user.key] = client;
    // Confirm credentials before changing an existing profile.
    must(await admin.from('profiles').upsert({ id: user.id, full_name: user.full_name, role: user.role }), 'create seed profile');
  }

  const projectDefinitions = [
    { key: 'shared', name: 'ЖК «Северный квартал»', address: 'Москва, Дмитровское шоссе, 82' },
    { key: 'executor1', name: 'Офисный центр «Высота»', address: 'Москва, ул. Бутырская, 46' },
    { key: 'executor2', name: 'Складской комплекс «Восток»', address: 'Балашиха, шоссе Энтузиастов, 18' },
  ];
  for (const definition of projectDefinitions) {
    if (!state.projects[definition.key]) {
      const project = await rpc(clients.manager1, 'create_project', { p_name: definition.name, p_address: definition.address });
      if (!project?.id) throw new Error('create_project did not return a project.');
      state.projects[definition.key] = project.id;
      await save();
    }
  }

  const taskDefinitions = [
    { key: 'survey', project: 'shared', executor: 'executor1', status: 'new', title: 'Проверить разбивку фундамента', description: 'Сверить оси и отметки с рабочей документацией. Зафиксировать отклонения до начала бетонирования.' },
    { key: 'delivery', project: 'shared', executor: 'executor2', status: 'in_progress', title: 'Принять поставку арматуры', description: 'Проверить количество, маркировку и сертификаты качества. Согласовать место складирования.' },
    { key: 'concrete', project: 'shared', executor: 'executor1', status: 'review', title: 'Подготовить акт скрытых работ', description: 'Подготовить акт на армирование перекрытия второго этажа и передать комплект на проверку.' },
    { key: 'safety', project: 'shared', executor: 'executor2', status: 'accepted', title: 'Организовать безопасный проход', description: 'Установить ограждение и указатели у входа на строительную площадку.' },
    { key: 'facade', project: 'shared', executor: 'executor1', status: 'rework', title: 'Устранить замечания по фасаду', description: 'Проверить примыкания оконных блоков в секции Б и устранить обнаруженные дефекты.' },
    { key: 'roof', project: 'executor1', executor: 'executor1', status: 'in_progress', title: 'Проверить гидроизоляцию кровли', description: 'Осмотреть швы и примыкания, подготовить перечень участков для контрольного пролива.' },
    { key: 'ventilation', project: 'executor2', executor: 'executor2', status: 'new', title: 'Согласовать трассы вентиляции', description: 'Сверить трассы с расположением светильников и согласовать пересечения со смежными системами.' },
    { key: 'electrical', project: 'executor2', executor: 'executor2', status: 'review', title: 'Проверить освещение складской зоны', description: 'Проверить группы освещения, маркировку щитов и работу аварийных светильников.' },
  ];
  for (const [index, definition] of taskDefinitions.entries()) {
    const manager = clients[index % 2 === 0 ? 'manager1' : 'manager2'];
    const executor = state.users.find((user) => user.key === definition.executor);
    if (!state.tasks[definition.key]) {
      const task = await rpc(manager, 'create_task', {
        p_project_id: state.projects[definition.project],
        p_title: definition.title,
        p_description: definition.description,
        p_assignee_id: executor.id,
      });
      if (!task?.id) throw new Error('create_task did not return a task.');
      state.tasks[definition.key] = task.id;
      await save();
    }
    const taskId = state.tasks[definition.key];
    let task = must(await clients.manager1.from('tasks').select('id,status').eq('id', taskId).single(), 'read seed task');
    for (let step = 0; task.status !== definition.status && step < 5; step += 1) {
      const next = task.status === 'new' ? 'in_progress'
        : task.status === 'in_progress' ? 'review'
          : task.status === 'review' ? definition.status === 'accepted' ? 'accepted' : 'rework'
            : null;
      if (!next) throw new Error('Seed task is in an unexpected state; no automatic reset is allowed.');
      const actor = next === 'accepted' || next === 'rework' ? manager : clients[definition.executor];
      await rpc(actor, 'transition_task', {
        p_task_id: taskId,
        p_expected_status: task.status,
        p_new_status: next,
        p_comment: next === 'rework' ? 'Уточните примыкания в секции Б: на двух участках остались незаделанные швы.' : null,
      });
      task = must(await clients.manager1.from('tasks').select('id,status').eq('id', taskId).single(), 'read seeded status');
    }
    if (task.status !== definition.status) throw new Error('Could not reach the requested demo status.');
  }
  state.complete = true;
  await save();
  console.log('Demo seed complete: 2 managers, 2 executors, 3 projects, 8 tasks across all 5 statuses.');
  console.log('Passwords are saved only in the ignored .demo-credentials.json file.');
}

main().catch((error) => {
  // API bodies may contain sensitive data: report only our operation/code messages.
  console.error(`Seed failed: ${error.message}`);
  process.exitCode = 1;
});
