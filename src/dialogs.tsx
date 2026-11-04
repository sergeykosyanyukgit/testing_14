import { useEffect, useState } from 'react';
import { Alert, Button, Group, Modal, Select, Stack, Textarea, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from './auth';
import { errorMessage, executors, projects, rpc } from './lib';
import type { Project, Task } from './types';

export function ProjectDialog({ opened, onClose, project, onSaved }: {
  opened: boolean; onClose: () => void; project?: Project; onSaved?: (saved: Project) => void;
}) {
  const { session } = useAuth();
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { if (opened) { setName(project?.name || ''); setAddress(project?.address || ''); setError(''); } }, [opened, project]);
  const mutation = useMutation({
    mutationFn: () => rpc<Project>(project ? 'update_project' : 'create_project', {
      ...(project ? { p_project_id: project.id } : {}), p_name: name.trim(), p_address: address.trim(),
    }),
    onSuccess: async (saved) => {
      await client.invalidateQueries({ queryKey: [session!.user.id] });
      onClose();
      notifications.show({ title: project ? 'Объект обновлён' : 'Объект создан', message: saved.name, color: 'teal' });
      onSaved?.(saved);
    },
    onError: (err) => setError(errorMessage(err)),
  });
  return <Modal opened={opened} onClose={onClose} title={project ? 'Редактировать объект' : 'Новый объект'} centered closeOnClickOutside={!mutation.isPending} closeOnEscape={!mutation.isPending} withCloseButton={!mutation.isPending}>
    <form onSubmit={(event) => {
      event.preventDefault(); setError('');
      if (!name.trim() || !address.trim()) { setError('Заполните название и адрес объекта.'); return; }
      mutation.mutate();
    }}>
      <Stack gap="md">
        <TextInput label="Название объекта" placeholder="Например, ЖК «Сосновый парк»" value={name} onChange={(e) => setName(e.currentTarget.value)} required autoFocus maxLength={200} disabled={mutation.isPending} />
        <Textarea label="Адрес" placeholder="Город, улица, номер дома" value={address} onChange={(e) => setAddress(e.currentTarget.value)} required minRows={2} maxLength={500} disabled={mutation.isPending} />
        {error && <Alert color="red" role="alert">{error}</Alert>}
        <Group justify="flex-end" mt="xs"><Button variant="default" onClick={onClose} disabled={mutation.isPending}>Отмена</Button><Button type="submit" loading={mutation.isPending}>{project ? 'Сохранить' : 'Создать объект'}</Button></Group>
      </Stack>
    </form>
  </Modal>;
}

export function TaskDialog({ opened, onClose, task, initialProjectId, onSaved }: {
  opened: boolean; onClose: () => void; task?: Task; initialProjectId?: string; onSaved?: (saved: Task) => void;
}) {
  const { session } = useAuth();
  const client = useQueryClient();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [assigneeId, setAssigneeId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const projectsQuery = useQuery({ queryKey: [session!.user.id, 'projects'], queryFn: projects, enabled: opened });
  const peopleQuery = useQuery({ queryKey: [session!.user.id, 'executors'], queryFn: executors, enabled: opened });
  useEffect(() => { if (opened) {
    setTitle(task?.title || ''); setDescription(task?.description || '');
    setProjectId(task?.project_id || initialProjectId || null); setAssigneeId(task?.assignee_id || null); setError('');
  } }, [opened, task, initialProjectId]);
  const mutation = useMutation({
    mutationFn: () => rpc<Task>(task ? 'update_task' : 'create_task', {
      ...(task ? { p_task_id: task.id } : {}), p_project_id: projectId,
      p_title: title.trim(), p_description: description.trim(), p_assignee_id: assigneeId,
    }),
    onSuccess: async (saved) => {
      await client.invalidateQueries({ queryKey: [session!.user.id] });
      onClose(); notifications.show({ title: task ? 'Задача обновлена' : 'Задача создана', message: saved.title, color: 'teal' });
      onSaved?.(saved);
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const loadError = projectsQuery.error || peopleQuery.error;
  return <Modal opened={opened} onClose={onClose} title={task ? 'Редактировать задачу' : 'Новая задача'} centered size="lg" closeOnClickOutside={!mutation.isPending} closeOnEscape={!mutation.isPending} withCloseButton={!mutation.isPending}>
    <form onSubmit={(event) => {
      event.preventDefault(); setError('');
      if (!title.trim() || !projectId || !assigneeId) { setError('Укажите название, объект и исполнителя.'); return; }
      mutation.mutate();
    }}><Stack gap="md">
      <TextInput label="Название задачи" placeholder="Что нужно сделать" value={title} onChange={(e) => setTitle(e.currentTarget.value)} required autoFocus maxLength={200} disabled={mutation.isPending} />
      <Textarea label="Описание" placeholder="Детали, объём работ и ожидаемый результат" value={description} onChange={(e) => setDescription(e.currentTarget.value)} minRows={4} autosize maxRows={8} maxLength={10000} disabled={mutation.isPending} />
      <Select label="Объект" placeholder={projectsQuery.isLoading ? 'Загружаем объекты…' : 'Выберите объект'} value={projectId} onChange={setProjectId} data={(projectsQuery.data || []).map((p) => ({ value: p.id, label: p.name }))} required searchable nothingFoundMessage="Объект не найден" disabled={mutation.isPending || projectsQuery.isLoading} />
      <Select label="Исполнитель" placeholder={peopleQuery.isLoading ? 'Загружаем исполнителей…' : 'Назначьте исполнителя'} value={assigneeId} onChange={setAssigneeId} data={(peopleQuery.data || []).map((p) => ({ value: p.id, label: p.full_name }))} required searchable nothingFoundMessage="Исполнитель не найден" disabled={mutation.isPending || peopleQuery.isLoading} />
      {task && <p className="form-note">При смене исполнителя статус сохранится. Предыдущий исполнитель потеряет доступ к задаче.</p>}
      {loadError && <Alert color="red">{errorMessage(loadError)} <Button variant="subtle" color="red" size="xs" onClick={() => { void projectsQuery.refetch(); void peopleQuery.refetch(); }}>Повторить</Button></Alert>}
      {peopleQuery.isSuccess && peopleQuery.data.length === 0 && <Alert color="yellow">Пока нет исполнителей. Администратор должен создать хотя бы одного пользователя с этой ролью.</Alert>}
      {error && <Alert color="red" role="alert">{error}</Alert>}
      <Group justify="flex-end" mt="xs"><Button variant="default" onClick={onClose} disabled={mutation.isPending}>Отмена</Button><Button type="submit" loading={mutation.isPending} disabled={!!loadError || !peopleQuery.data?.length || !projectsQuery.data?.length}>{task ? 'Сохранить' : 'Создать задачу'}</Button></Group>
    </Stack></form>
  </Modal>;
}

export function ArchiveDialog({ opened, onClose, kind, id, name, onArchived }: {
  opened: boolean; onClose: () => void; kind: 'project' | 'task'; id: string; name: string; onArchived: () => void;
}) {
  const { session } = useAuth();
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => rpc(kind === 'project' ? 'archive_project' : 'archive_task', kind === 'project' ? { p_project_id: id } : { p_task_id: id }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: [session!.user.id] }); onClose(); onArchived();
      notifications.show({ title: kind === 'project' ? 'Объект удалён' : 'Задача удалена', message: 'История изменений сохранена.', color: 'gray' });
    },
  });
  return <Modal opened={opened} onClose={onClose} title={kind === 'project' ? 'Удалить объект?' : 'Удалить задачу?'} centered closeOnClickOutside={!mutation.isPending} closeOnEscape={!mutation.isPending} withCloseButton={!mutation.isPending}>
    <Stack gap="md">
      <p className="confirm-name">{name}</p>
      <p className="form-note">{kind === 'project' ? 'Объект и все его задачи исчезнут из рабочих списков.' : 'Задача исчезнет из рабочих списков.'} История останется в базе. Восстановление через интерфейс не предусмотрено.</p>
      {mutation.error && <Alert color="red" role="alert">{errorMessage(mutation.error)}</Alert>}
      <Group justify="flex-end"><Button variant="default" onClick={onClose} disabled={mutation.isPending}>Отмена</Button><Button color="red" onClick={() => mutation.mutate()} loading={mutation.isPending}>Удалить</Button></Group>
    </Stack>
  </Modal>;
}
