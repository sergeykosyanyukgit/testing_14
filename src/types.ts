export type Role = 'manager' | 'executor';
export type TaskStatus = 'new' | 'in_progress' | 'review' | 'accepted' | 'rework';

export interface Profile {
  id: string;
  full_name: string;
  role: Role;
}

export interface Project {
  id: string;
  name: string;
  address: string;
  created_at: string;
  deleted_at: string | null;
  tasks?: { id: string; status: TaskStatus }[];
}

export interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string;
  assignee_id: string;
  status: TaskStatus;
  author_id: string;
  author_name: string;
  created_at: string;
  deleted_at: string | null;
  assignee?: { full_name: string } | null;
  project?: { name: string; address: string } | null;
}

export interface StatusEvent {
  id: string;
  task_id: string;
  from_status: TaskStatus | null;
  to_status: TaskStatus;
  actor_id: string;
  actor_name: string;
  created_at: string;
  comment: string | null;
}

export const STATUS: Record<TaskStatus, { label: string; color: string }> = {
  new: { label: 'Новая', color: 'gray' },
  in_progress: { label: 'В работе', color: 'blue' },
  review: { label: 'На проверке', color: 'orange' },
  accepted: { label: 'Принята', color: 'teal' },
  rework: { label: 'На доработке', color: 'red' },
};

export const statusOptions = Object.entries(STATUS).map(([value, { label }]) => ({ value, label }));

export const roleLabel = (role: Role) => role === 'manager' ? 'Постановщик' : 'Исполнитель';

export const formatDate = (value: string) => new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
}).format(new Date(value));
