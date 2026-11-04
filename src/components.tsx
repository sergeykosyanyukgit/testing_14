import { Alert, Badge, Button, Loader } from '@mantine/core';
import { IconAlertCircle, IconArrowRight, IconClipboardList, IconMapPin } from '@tabler/icons-react';
import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import { errorMessage } from './lib';
import { formatDate, STATUS } from './types';
import type { Task, TaskStatus } from './types';

export function StatusBadge({ status }: { status: TaskStatus }) {
  const info = STATUS[status];
  return <Badge className="status-badge" color={info.color} variant="light" size="lg" radius="sm">
    <span className={`status-dot status-dot-${status}`} />{info.label}
  </Badge>;
}

export function Loading({ label = 'Загружаем данные…' }: { label?: string }) {
  return <div className="loading-state" role="status"><Loader color="orange" size="sm" /><span>{label}</span></div>;
}

export function ErrorState({ error, onRetry }: { error?: unknown; onRetry?: () => void }) {
  return <Alert color="red" icon={<IconAlertCircle size={19} />} title="Не удалось загрузить данные" mt="lg">
    {errorMessage(error)}
    {onRetry && <div style={{ marginTop: 12 }}><Button variant="white" color="red" size="xs" onClick={onRetry}>Повторить</Button></div>}
  </Alert>;
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state">
    <span className="empty-icon"><IconClipboardList size={28} stroke={1.5} /></span>
    <h3>{title}</h3><p>{description}</p>{action}
  </div>;
}

export function Unavailable({ kind = 'Запись' }: { kind?: string }) {
  return <div className="unavailable">
    <IconAlertCircle size={34} stroke={1.5} /><h2>{kind} недоступна</h2>
    <p>Возможно, запись удалили или у вас больше нет доступа.</p>
    <Button component={Link} to="/projects" variant="light">К объектам</Button>
  </div>;
}

export function PageTitle({ eyebrow, title, description, actions }: {
  eyebrow: string; title: string; description?: ReactNode; actions?: ReactNode;
}) {
  return <header className="page-heading">
    <div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{description && <div className="page-description">{description}</div>}</div>
    {actions && <div className="heading-actions">{actions}</div>}
  </header>;
}

export function TaskList({ tasks, showProject = false }: { tasks: Task[]; showProject?: boolean }) {
  return <div className={`task-list ${showProject ? 'with-project' : ''}`}>
    <div className="task-list-head"><span>Задача</span><span>Статус</span><span>Исполнитель</span><span>Создана</span><span /></div>
    {tasks.map((task) => <Link className="task-row" to={`/tasks/${task.id}`} key={task.id}>
      <div className="task-title-cell"><span className="task-name">{task.title}</span>
        {showProject && task.project && <span className="task-project"><IconMapPin size={13} />{task.project.name}</span>}
      </div>
      <span className="task-status-cell"><StatusBadge status={task.status} /></span>
      <span className="task-assignee"><span className="person-dot">{(task.assignee?.full_name || 'И').slice(0, 1)}</span>{task.assignee?.full_name || 'Исполнитель'}</span>
      <time className="task-created" dateTime={task.created_at}>{formatDate(task.created_at).split(' г.')[0]}</time>
      <IconArrowRight className="row-arrow" size={18} stroke={1.5} />
    </Link>)}
  </div>;
}
