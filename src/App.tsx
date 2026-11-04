import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  ActionIcon, Alert, Avatar, Button, Drawer, Group, Modal, PasswordInput,
  Select, Stack, Textarea, TextInput, Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconArrowLeft, IconArrowRight, IconBuildingCommunity, IconCheck,
  IconChevronRight, IconClipboardList, IconEdit, IconLayoutSidebarLeftCollapse,
  IconLogout, IconMapPin, IconMenu2, IconPlus, IconRefresh, IconSearch,
  IconSend, IconShieldCheck, IconTrash, IconUser,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, NavLink, Outlet, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from './auth';
import { configured, errorMessage, history, projectById, projects, rpc, supabase, taskById, tasks } from './lib';
import { EmptyState, ErrorState, Loading, PageTitle, StatusBadge, TaskList, Unavailable } from './components';
import { ArchiveDialog, ProjectDialog, TaskDialog } from './dialogs';
import { formatDate, roleLabel, STATUS, statusOptions } from './types';
import type { TaskStatus } from './types';

function Brand({ compact = false }: { compact?: boolean }) {
  return <Link to="/" className={`brand ${compact ? 'brand-compact' : ''}`} aria-label="Объекты — на главную">
    <span className="brand-symbol"><IconBuildingCommunity size={25} stroke={1.7} /></span>
    <span className="brand-wordmark">Объекты<span>И ЗАДАЧИ · CRM</span></span>
  </Link>;
}

function LogoutButton({ full = false }: { full?: boolean }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const mutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.auth.signOut({ scope: 'local' });
      if (error) throw error;
    },
    onSuccess: () => { client.clear(); navigate('/login', { replace: true }); },
    onError: (error) => notifications.show({ title: 'Не удалось выйти', message: errorMessage(error), color: 'red' }),
  });
  if (full) return <Button variant="default" leftSection={<IconLogout size={17} />} loading={mutation.isPending} onClick={() => mutation.mutate()}>Выйти</Button>;
  return <Tooltip label="Выйти"><ActionIcon variant="subtle" color="gray" size="lg" aria-label="Выйти из системы" loading={mutation.isPending} onClick={() => mutation.mutate()}><IconLogout size={20} /></ActionIcon></Tooltip>;
}

function Gate() {
  const { session, loading, profile, profileLoading, profileError, retryProfile } = useAuth();
  if (loading) return <div className="full-state"><Loading label="Проверяем вход…" /></div>;
  if (!session) return <Navigate to="/login" replace />;
  if (profileLoading) return <div className="full-state"><Loading label="Открываем рабочее пространство…" /></div>;
  if (profileError || !profile) return <div className="full-state"><div className="access-message">
    <Brand /><h2>Профиль недоступен</h2><p>Не удалось получить ваш профиль. Повторите попытку или обратитесь к администратору для проверки доступа.</p>
    <Group justify="center"><Button onClick={retryProfile}>Повторить</Button><LogoutButton full /></Group>
  </div></div>;
  return <Outlet />;
}

function Home() {
  const { profile } = useAuth();
  return <Navigate to={profile?.role === 'executor' ? '/my-tasks' : '/projects'} replace />;
}

function Shell() {
  const { profile } = useAuth();
  const [opened, setOpened] = useState(false);
  const navigation = <>
    <div className="sidebar-brand"><Brand /></div>
    <div className="nav-caption">РАБОЧЕЕ ПРОСТРАНСТВО</div>
    <nav className="main-nav" aria-label="Основная навигация">
      <NavLink to="/projects" onClick={() => setOpened(false)} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><IconBuildingCommunity size={20} stroke={1.6} />Объекты<IconChevronRight size={15} className="nav-arrow" /></NavLink>
      {profile!.role === 'executor' && <NavLink to="/my-tasks" onClick={() => setOpened(false)} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><IconClipboardList size={20} stroke={1.6} />Мои задачи<IconChevronRight size={15} className="nav-arrow" /></NavLink>}
    </nav>
    <div className="sidebar-bottom">
      <div className="workspace-note"><span className="live-dot" />Рабочее пространство</div>
      <div className="user-panel"><Avatar size={36} radius="xl" color="gray">{profile!.full_name.split(' ').slice(0, 2).map((word) => word[0]).join('')}</Avatar>
        <div className="user-details"><strong>{profile!.full_name}</strong><span>{roleLabel(profile!.role)}</span></div><LogoutButton />
      </div>
    </div>
  </>;
  return <div className="app-shell">
    <aside className="sidebar">{navigation}</aside>
    <Drawer opened={opened} onClose={() => setOpened(false)} size={280} padding={0} withCloseButton={false} classNames={{ body: 'drawer-body', content: 'drawer-content' }}>{navigation}</Drawer>
    <div className="workspace">
      <div className="mobile-header"><Brand compact /><ActionIcon variant="default" size="lg" onClick={() => setOpened(true)} aria-label="Открыть меню"><IconMenu2 size={20} /></ActionIcon></div>
      <div className="workspace-topbar"><span><IconLayoutSidebarLeftCollapse size={17} stroke={1.5} />Объекты и задачи</span><span className="topbar-role"><IconUser size={15} />{roleLabel(profile!.role)}</span></div>
      <main className="main-content"><Outlet /></main>
      <footer className="workspace-footer"><span>Объекты и задачи · Мини-CRM</span><span>Рабочее пространство команды</span></footer>
    </div>
  </div>;
}

function LoginPage() {
  const { session, loading, sessionError } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const mutation = useMutation({ mutationFn: async () => {
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) throw error;
  } });
  if (loading) return <div className="full-state"><Loading label="Проверяем вход…" /></div>;
  if (session) return <Navigate to="/" replace />;
  return <main className="login-page">
    <section className="login-intro" aria-label="Объекты и задачи">
      <Brand />
      <div className="login-intro-copy"><span className="eyebrow">ОБЪЕКТЫ И ЗАДАЧИ</span><h1>Работа по объектам.<br />Всё на своих местах.</h1><p>Ставьте задачи, следите за выполнением<br className="desktop-break" /> и принимайте готовую работу.</p>
        <div className="login-workflow"><span><i />Задача</span><IconArrowRight size={17} /><span><i />Работа</span><IconArrowRight size={17} /><span><i />Приёмка</span></div>
      </div>
      <span className="login-intro-footer">Мини-CRM для строительной команды</span>
    </section>
    <section className="login-form-side"><div className="login-form-wrap">
      <div className="login-mobile-brand"><Brand /></div>
      <span className="form-kicker">ДОБРО ПОЖАЛОВАТЬ</span><h2>Вход в систему</h2><p className="login-subtitle">Введите рабочий email и пароль.</p>
      <form onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}><Stack gap="lg">
        <TextInput size="md" label="Email" placeholder="name@company.ru" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.currentTarget.value)} disabled={mutation.isPending} />
        <PasswordInput size="md" label="Пароль" placeholder="Ваш пароль" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.currentTarget.value)} disabled={mutation.isPending} />
        {sessionError && !mutation.error && <Alert color="yellow">Не удалось восстановить сессию. Войдите ещё раз.</Alert>}
        {mutation.error && <Alert color="red" role="alert">{errorMessage(mutation.error)}</Alert>}
        <Button type="submit" size="md" fullWidth loading={mutation.isPending} rightSection={<IconArrowRight size={18} />}>Войти в систему</Button>
      </Stack></form>
      <div className="login-access-note"><IconShieldCheck size={20} stroke={1.6} /><span>По вопросам доступа обратитесь<br />к администратору вашей команды.</span></div>
    </div></section>
  </main>;
}

function ProjectsPage() {
  const { session, profile } = useAuth();
  const [search, setSearch] = useState('');
  const [createOpened, setCreateOpened] = useState(false);
  const navigate = useNavigate();
  const query = useQuery({ queryKey: [session!.user.id, 'projects'], queryFn: projects });
  const allProjects = query.data || [];
  const filtered = allProjects.filter((project) => `${project.name} ${project.address}`.toLowerCase().includes(search.toLowerCase().trim()));
  const manager = profile!.role === 'manager';
  return <div className="page-enter">
    <PageTitle eyebrow="РАБОЧЕЕ ПРОСТРАНСТВО" title="Объекты" description={manager ? 'Стройки, задачи и ход выполнения работ.' : 'Объекты, на которых вам назначены задачи.'}
      actions={manager && <Button leftSection={<IconPlus size={18} />} onClick={() => setCreateOpened(true)}>Новый объект</Button>} />
    <div className="list-toolbar"><div className="section-count">Все объекты <span>{allProjects.length}</span></div><TextInput value={search} onChange={(e) => setSearch(e.currentTarget.value)} placeholder="Найти объект или адрес" aria-label="Найти объект или адрес" leftSection={<IconSearch size={17} />} className="search-input" /></div>
    {query.isLoading ? <Loading /> : query.error ? <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} /> : !filtered.length ? <EmptyState
      title={search ? 'Ничего не найдено' : 'Пока нет объектов'} description={search ? 'Попробуйте изменить название или адрес.' : manager ? 'Создайте первый объект и добавьте к нему задачи.' : 'Здесь появятся объекты, когда вам назначат задачи.'}
      action={!search && manager ? <Button variant="light" leftSection={<IconPlus size={17} />} onClick={() => setCreateOpened(true)}>Создать объект</Button> : undefined} /> : <div className="project-list">
      <div className="project-list-head"><span>Объект</span><span>Задачи</span><span>Принято</span><span /></div>
      {filtered.map((project) => {
        const total = project.tasks?.length || 0;
        const accepted = project.tasks?.filter((task) => task.status === 'accepted').length || 0;
        return <Link className="project-row" to={`/projects/${project.id}`} key={project.id}>
          <span className="project-identity"><span className="project-icon"><IconBuildingCommunity size={24} stroke={1.4} /></span><span><strong>{project.name}</strong><span className="address"><IconMapPin size={14} />{project.address}</span></span></span>
          <span className="project-task-count">{total}<span className="mobile-task-label"> задач</span></span>
          <span className="project-completion"><span>{accepted}<em> / {total}</em></span><span className="progress-track"><span style={{ width: `${total ? accepted / total * 100 : 0}%` }} /></span></span>
          <span className="project-open"><IconArrowRight size={19} stroke={1.5} /></span>
        </Link>;
      })}
    </div>}
    <div className="list-footnote">{manager ? 'Откройте объект, чтобы посмотреть задачи и назначить работы.' : 'Внутри объекта отображаются только ваши задачи.'}</div>
    {manager && <ProjectDialog opened={createOpened} onClose={() => setCreateOpened(false)} onSaved={(saved) => navigate(`/projects/${saved.id}`)} />}
  </div>;
}

function ProjectPage() {
  const { projectId = '' } = useParams();
  const { session, profile } = useAuth();
  const navigate = useNavigate();
  const [editOpened, setEditOpened] = useState(false);
  const [createOpened, setCreateOpened] = useState(false);
  const [archiveOpened, setArchiveOpened] = useState(false);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const projectQuery = useQuery({ queryKey: [session!.user.id, 'project', projectId], queryFn: () => projectById(projectId) });
  const tasksQuery = useQuery({ queryKey: [session!.user.id, 'tasks', projectId], queryFn: () => tasks(projectId), enabled: !!projectQuery.data });
  if (projectQuery.isLoading) return <Loading />;
  if (projectQuery.error) return <ErrorState error={projectQuery.error} onRetry={() => { void projectQuery.refetch(); }} />;
  if (!projectQuery.data) return <Unavailable kind="Карточка объекта" />;
  const project = projectQuery.data;
  const manager = profile!.role === 'manager';
  const allTasks = tasksQuery.data || [];
  const filtered = allTasks.filter((task) => (!status || task.status === status) && task.title.toLowerCase().includes(search.toLowerCase().trim()));
  const accepted = allTasks.filter((task) => task.status === 'accepted').length;
  return <div className="page-enter">
    <nav className="breadcrumbs" aria-label="Хлебные крошки"><Link to="/projects">Объекты</Link><IconChevronRight size={13} /><span aria-current="page">Карточка объекта</span></nav>
    <PageTitle eyebrow="ОБЪЕКТ" title={project.name} description={<span className="inline-address"><IconMapPin size={17} />{project.address}</span>}
      actions={manager && <Group gap="xs"><Button variant="default" leftSection={<IconEdit size={16} />} onClick={() => setEditOpened(true)}>Редактировать</Button><Tooltip label="Удалить объект"><ActionIcon variant="default" color="red" size={36} onClick={() => setArchiveOpened(true)} aria-label="Удалить объект"><IconTrash size={17} /></ActionIcon></Tooltip></Group>} />
    <div className="object-summary"><div><strong>{allTasks.length}</strong><span>Всего задач</span></div><div><strong>{allTasks.filter((task) => task.status === 'in_progress').length}</strong><span>В работе</span></div><div><strong>{allTasks.filter((task) => task.status === 'review').length}</strong><span>На проверке</span></div><div><strong>{accepted}<small>/{allTasks.length}</small></strong><span>Принято</span></div></div>
    <div className="tasks-section-heading"><h2>{manager ? 'Задачи объекта' : 'Мои задачи на объекте'}</h2>{manager && <Button leftSection={<IconPlus size={17} />} onClick={() => setCreateOpened(true)}>Новая задача</Button>}</div>
    <div className="task-filters"><TextInput value={search} onChange={(e) => setSearch(e.currentTarget.value)} placeholder="Найти задачу" aria-label="Найти задачу" leftSection={<IconSearch size={16} />} className="task-search" /><Select placeholder="Все статусы" aria-label="Фильтр по статусу" data={statusOptions} value={status} onChange={setStatus} clearable className="status-filter" /></div>
    {tasksQuery.isLoading ? <Loading /> : tasksQuery.error ? <ErrorState error={tasksQuery.error} onRetry={() => { void tasksQuery.refetch(); }} /> : !filtered.length ? <EmptyState title={search || status ? 'Задачи не найдены' : 'Задач пока нет'} description={search || status ? 'Измените поиск или выберите другой статус.' : manager ? 'Добавьте задачу и назначьте ответственного за выполнение.' : 'На этом объекте пока нет доступных вам задач.'} /> : <TaskList tasks={filtered} />}
    {manager && <><ProjectDialog opened={editOpened} onClose={() => setEditOpened(false)} project={project} /><TaskDialog opened={createOpened} onClose={() => setCreateOpened(false)} initialProjectId={project.id} onSaved={(saved) => navigate(`/tasks/${saved.id}`)} /><ArchiveDialog opened={archiveOpened} onClose={() => setArchiveOpened(false)} kind="project" id={project.id} name={project.name} onArchived={() => navigate('/projects')} /></>}
  </div>;
}

function MyTasksPage() {
  const { session, profile } = useAuth();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const query = useQuery({ queryKey: [session!.user.id, 'tasks', 'mine'], queryFn: () => tasks(), enabled: profile!.role === 'executor' });
  if (profile!.role !== 'executor') return <Navigate to="/projects" replace />;
  const allTasks = query.data || [];
  const filtered = allTasks.filter((task) => (!status || task.status === status) && `${task.title} ${task.project?.name || ''}`.toLowerCase().includes(search.toLowerCase().trim()));
  return <div className="page-enter">
    <PageTitle eyebrow="ЛИЧНАЯ РАБОТА" title="Мои задачи" description="Назначенные вам работы по всем объектам." />
    <div className="list-toolbar"><div className="section-count">Все задачи <span>{allTasks.length}</span></div><Button variant="subtle" color="gray" size="xs" leftSection={<IconRefresh size={15} />} loading={query.isFetching} onClick={() => { void query.refetch(); }}>Обновить</Button></div>
    <div className="task-filters"><TextInput value={search} onChange={(e) => setSearch(e.currentTarget.value)} placeholder="Найти задачу или объект" aria-label="Найти задачу или объект" leftSection={<IconSearch size={16} />} className="task-search" /><Select placeholder="Все статусы" aria-label="Фильтр по статусу" data={statusOptions} value={status} onChange={setStatus} clearable className="status-filter" /></div>
    {query.isLoading ? <Loading /> : query.error ? <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} /> : !filtered.length ? <EmptyState title={search || status ? 'Задачи не найдены' : 'У вас пока нет задач'} description={search || status ? 'Попробуйте изменить условия поиска.' : 'Назначенные вам задачи появятся здесь.'} /> : <TaskList tasks={filtered} showProject />}
  </div>;
}

function TaskPage() {
  const { taskId = '' } = useParams();
  const { session, profile } = useAuth();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [editOpened, setEditOpened] = useState(false);
  const [archiveOpened, setArchiveOpened] = useState(false);
  const [reworkOpened, setReworkOpened] = useState(false);
  const [comment, setComment] = useState('');
  const [actionError, setActionError] = useState('');
  const query = useQuery({ queryKey: [session!.user.id, 'task', taskId], queryFn: () => taskById(taskId) });
  const historyQuery = useQuery({ queryKey: [session!.user.id, 'history', taskId], queryFn: () => history(taskId), enabled: !!query.data });
  const mutation = useMutation({
    mutationFn: (toStatus: TaskStatus) => rpc('transition_task', {
      p_task_id: taskId, p_expected_status: query.data!.status, p_new_status: toStatus,
      p_comment: toStatus === 'rework' ? comment.trim() : null,
    }),
    onSuccess: async () => {
      setActionError(''); setReworkOpened(false); setComment('');
      await client.invalidateQueries({ queryKey: [session!.user.id] });
      notifications.show({ title: 'Статус изменён', message: 'Действие сохранено в истории задачи.', color: 'teal' });
    },
    onError: async (error) => {
      setActionError(errorMessage(error));
      await client.invalidateQueries({ queryKey: [session!.user.id] });
    },
  });
  if (query.isLoading) return <Loading />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} />;
  if (!query.data) return <Unavailable kind="Задача" />;
  const task = query.data;
  const manager = profile!.role === 'manager';
  const assigned = profile!.role === 'executor' && task.assignee_id === session!.user.id;
  const canStart = assigned && (task.status === 'new' || task.status === 'rework');
  const canSubmit = assigned && task.status === 'in_progress';
  const canReview = manager && task.status === 'review';
  const hasActions = canStart || canSubmit || canReview;
  const transition = (to: TaskStatus) => { setActionError(''); mutation.mutate(to); };
  const returnForRework = (event: FormEvent) => {
    event.preventDefault();
    if (!comment.trim()) { setActionError('Напишите, что необходимо исправить.'); return; }
    transition('rework');
  };
  return <div className="page-enter">
    <nav className="breadcrumbs" aria-label="Хлебные крошки"><Link to="/projects">Объекты</Link><IconChevronRight size={13} /><Link to={`/projects/${task.project_id}`}>{task.project?.name || 'Объект'}</Link><IconChevronRight size={13} /><span aria-current="page">Задача</span></nav>
    <div className="task-detail-heading"><div className="task-heading-meta"><span className="eyebrow">ЗАДАЧА</span><StatusBadge status={task.status} /></div><h1>{task.title}</h1>
      {manager && <Group gap="xs" className="task-edit-actions"><Button variant="default" leftSection={<IconEdit size={16} />} onClick={() => setEditOpened(true)}>Редактировать</Button><Tooltip label="Удалить задачу"><ActionIcon variant="default" size={36} color="red" aria-label="Удалить задачу" onClick={() => setArchiveOpened(true)}><IconTrash size={17} /></ActionIcon></Tooltip></Group>}
    </div>
    <div className="task-detail-grid"><div className="task-detail-main">
      <section className="task-description"><h2>Описание задачи</h2>{task.description ? <p>{task.description}</p> : <p className="muted">Описание не добавлено.</p>}</section>
      <section className="history-section"><div className="section-heading"><h2>История задачи</h2><span>{historyQuery.data?.length || 0} событий</span></div>
        {historyQuery.isLoading ? <Loading label="Загружаем историю…" /> : historyQuery.error ? <ErrorState error={historyQuery.error} onRetry={() => { void historyQuery.refetch(); }} /> : !historyQuery.data?.length ? <p className="muted">В истории пока нет событий.</p> : <ol className="history-list">
          {historyQuery.data.map((event, index) => <li key={event.id} className={index === 0 ? 'history-event latest' : 'history-event'}><span className="history-node">{index === 0 ? <IconCheck size={12} stroke={2.5} /> : null}</span><div className="history-event-content"><div className="history-event-header"><strong>{event.actor_name}</strong><time dateTime={event.created_at}>{formatDate(event.created_at)}</time></div><div className="history-transition">{event.from_status ? <><span>{STATUS[event.from_status].label}</span><IconArrowRight size={14} /><strong>{STATUS[event.to_status].label}</strong></> : <><span>Создана задача</span><IconArrowRight size={14} /><strong>{STATUS[event.to_status].label}</strong></>}</div>{event.comment && <blockquote>{event.comment}</blockquote>}</div></li>)}
        </ol>}
      </section>
    </div><aside className="task-inspector">
      <section className="task-properties"><h3>Данные задачи</h3><dl><div><dt>Объект</dt><dd><Link to={`/projects/${task.project_id}`}><IconBuildingCommunity size={16} />{task.project?.name || 'Объект'}<IconChevronRight size={13} /></Link></dd></div><div><dt>Исполнитель</dt><dd className="property-person"><Avatar size={25} radius="xl" color="gray">{(task.assignee?.full_name || 'И')[0]}</Avatar>{task.assignee?.full_name || 'Исполнитель'}</dd></div><div><dt>Постановщик</dt><dd>{task.author_name}</dd></div><div><dt>Дата создания</dt><dd><time dateTime={task.created_at}>{formatDate(task.created_at)}</time></dd></div></dl></section>
      <section className="task-actions"><h3>{hasActions ? 'Действия' : 'Текущий этап'}</h3>
        {task.status === 'accepted' ? <div className="accepted-note"><IconCheck size={21} /><strong>Работа принята</strong><p>Задача завершена.</p></div> : <>
          <p>{canStart ? 'Когда будете готовы приступить, возьмите задачу в работу.' : canSubmit ? 'Работа выполнена? Отправьте результат постановщику на проверку.' : canReview ? 'Проверьте выполненную работу и примите её или верните с замечаниями.' : task.status === 'review' ? 'Задача отправлена постановщику. Ожидайте результата проверки.' : task.status === 'new' ? 'Ожидает начала работы исполнителем.' : task.status === 'rework' ? 'Ожидает доработки исполнителем.' : 'Исполнитель выполняет задачу.'}</p>
          <Stack gap="sm">
            {canStart && <Button fullWidth leftSection={<IconArrowRight size={17} />} loading={mutation.isPending} onClick={() => transition('in_progress')}>{task.status === 'rework' ? 'Продолжить работу' : 'Взять в работу'}</Button>}
            {canSubmit && <Button fullWidth leftSection={<IconSend size={17} />} loading={mutation.isPending} onClick={() => transition('review')}>Отправить на проверку</Button>}
            {canReview && <><Button fullWidth leftSection={<IconCheck size={18} />} loading={mutation.isPending} onClick={() => transition('accepted')}>Принять задачу</Button><Button fullWidth variant="default" disabled={mutation.isPending} onClick={() => { setActionError(''); setComment(''); setReworkOpened(true); }}>Вернуть на доработку</Button></>}
          </Stack>
        </>}
        {actionError && !reworkOpened && <Alert color="red" mt="md" role="alert">{actionError}</Alert>}
      </section>
    </aside></div>
    <Link className="back-link" to={`/projects/${task.project_id}`}><IconArrowLeft size={16} />К задачам объекта</Link>
    <Modal opened={reworkOpened} onClose={() => setReworkOpened(false)} title="Вернуть на доработку" centered closeOnClickOutside={!mutation.isPending} closeOnEscape={!mutation.isPending} withCloseButton={!mutation.isPending}>
      <form onSubmit={returnForRework}><Stack gap="md"><p className="form-note">Объясните исполнителю, что нужно исправить. Комментарий сохранится в истории задачи.</p><Textarea label="Замечания" placeholder="Что необходимо доработать?" required autoFocus value={comment} onChange={(e) => setComment(e.currentTarget.value)} minRows={4} maxLength={10000} disabled={mutation.isPending} />{actionError && <Alert color="red" role="alert">{actionError}</Alert>}<Group justify="flex-end"><Button variant="default" onClick={() => setReworkOpened(false)} disabled={mutation.isPending}>Отмена</Button><Button type="submit" loading={mutation.isPending}>Вернуть на доработку</Button></Group></Stack></form>
    </Modal>
    {manager && <><TaskDialog opened={editOpened} onClose={() => setEditOpened(false)} task={task} /><ArchiveDialog opened={archiveOpened} onClose={() => setArchiveOpened(false)} kind="task" id={task.id} name={task.title} onArchived={() => navigate(`/projects/${task.project_id}`)} /></>}
  </div>;
}

export function App() {
  if (!configured) return <div className="full-state"><div className="access-message"><h1>Приложение не настроено</h1><p>Администратору необходимо указать публичные параметры подключения Supabase и повторить сборку.</p></div></div>;
  return <Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route element={<Gate />}><Route element={<Shell />}>
      <Route index element={<Home />} />
      <Route path="/projects" element={<ProjectsPage />} />
      <Route path="/projects/:projectId" element={<ProjectPage />} />
      <Route path="/tasks/:taskId" element={<TaskPage />} />
      <Route path="/my-tasks" element={<MyTasksPage />} />
      <Route path="*" element={<div className="unavailable"><h1>Страница не найдена</h1><p>Проверьте адрес или вернитесь к объектам.</p><Button component={Link} to="/projects" variant="light">К объектам</Button></div>} />
    </Route></Route>
  </Routes>;
}
