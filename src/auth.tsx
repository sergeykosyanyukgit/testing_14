import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { profileById, supabase } from './lib';
import type { Profile } from './types';

interface AuthValue {
  session: Session | null;
  loading: boolean;
  sessionError: boolean;
  profile?: Profile;
  profileLoading: boolean;
  profileError: unknown;
  retryProfile: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionError, setSessionError] = useState(false);

  useEffect(() => {
    let live = true;
    let currentUser: string | null = null;
    const update = (next: Session | null) => {
      if (!live) return;
      const nextUser = next?.user.id ?? null;
      if (currentUser !== nextUser) queryClient.clear();
      currentUser = nextUser;
      setSession(next);
      setLoading(false);
    };
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => update(next));
    supabase.auth.getSession().then(({ data, error }) => {
      if (!live) return;
      if (error) setSessionError(true);
      update(data.session);
    }).catch(() => { if (live) { setSessionError(true); setLoading(false); } });
    return () => { live = false; subscription.unsubscribe(); };
  }, [queryClient]);

  const profileQuery = useQuery({
    queryKey: [session?.user.id, 'profile'],
    queryFn: () => profileById(session!.user.id),
    enabled: !!session,
    retry: 1,
  });

  return <AuthContext.Provider value={{ session, loading, sessionError,
    profile: profileQuery.data, profileLoading: profileQuery.isLoading,
    profileError: profileQuery.error, retryProfile: () => { void profileQuery.refetch(); },
  }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error('AuthProvider is missing');
  return auth;
}
