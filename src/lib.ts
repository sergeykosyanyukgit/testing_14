import { createClient } from '@supabase/supabase-js';
import type { Profile, Project, StatusEvent, Task } from './types';

export const configured = Boolean(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);

// Only these two public configuration values are included in the browser bundle.
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL || 'https://unconfigured.supabase.co',
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'unconfigured',
);

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message
    : typeof error === 'object' && error && 'message' in error ? String(error.message) : '';
  if (message.includes('Invalid login credentials')) return 'Неверный email или пароль.';
  if (/Email not confirmed/i.test(message)) return 'Email пользователя ещё не подтверждён. Обратитесь к администратору.';
  if (/Failed to fetch|fetch failed|network|NetworkError/i.test(message)) return 'Не удалось связаться с сервером. Проверьте подключение и повторите попытку.';
  if (/rate limit|too many requests/i.test(message)) return 'Слишком много попыток. Подождите немного и повторите.';
  if (/refresh token|JWT expired|invalid JWT/i.test(message)) return 'Сессия завершилась. Войдите в систему ещё раз.';
  if (/conflict|status.*changed|expected.*status|concurrent|измен.*статус|статус.*измен/i.test(message)) return 'Статус задачи уже изменился. Данные обновлены — выберите действие ещё раз.';
  if (/not found|not_found|forbidden|permission|access denied|unavailable|не найден|недоступ|доступ запрещ/i.test(message)) return 'Запись недоступна. Возможно, её удалили или изменили исполнителя.';
  if (/[а-яА-ЯёЁ]/.test(message)) return message;
  if (/comment/i.test(message)) return 'При возврате на доработку нужен непустой комментарий.';
  if (/transition/i.test(message)) return 'Этот переход сейчас недоступен. Обновите задачу.';
  return 'Не удалось выполнить действие. Обновите страницу и попробуйте ещё раз.';
}

const taskSelect = '*,assignee:profiles!tasks_assignee_id_fkey(full_name),project:projects!tasks_project_id_fkey(name,address)';

export async function profileById(id: string): Promise<Profile> {
  const { data, error } = await supabase.from('profiles').select('id,full_name,role').eq('id', id).single();
  if (error) throw error;
  return data as Profile;
}

export async function executors(): Promise<Profile[]> {
  const { data, error } = await supabase.from('profiles').select('id,full_name,role').eq('role', 'executor').order('full_name');
  if (error) throw error;
  return data as Profile[];
}

export async function projects(): Promise<Project[]> {
  const { data, error } = await supabase.from('projects').select('*,tasks(id,status)').order('created_at', { ascending: false });
  if (error) throw error;
  return data as Project[];
}

export async function projectById(id: string): Promise<Project | null> {
  const { data, error } = await supabase.from('projects').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data as Project | null;
}

export async function tasks(projectId?: string): Promise<Task[]> {
  let query = supabase.from('tasks').select(taskSelect).order('created_at', { ascending: false });
  if (projectId) query = query.eq('project_id', projectId);
  const { data, error } = await query;
  if (error) throw error;
  return data as unknown as Task[];
}

export async function taskById(id: string): Promise<Task | null> {
  const { data, error } = await supabase.from('tasks').select(taskSelect).eq('id', id).maybeSingle();
  if (error) throw error;
  return data as unknown as Task | null;
}

export async function history(taskId: string): Promise<StatusEvent[]> {
  const { data, error } = await supabase.from('task_status_history').select('*').eq('task_id', taskId)
    .order('created_at', { ascending: false }).order('id', { ascending: false });
  if (error) throw error;
  return data as StatusEvent[];
}

export async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return (Array.isArray(data) ? data[0] : data) as T;
}
