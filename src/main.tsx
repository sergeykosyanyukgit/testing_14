import React from 'react';
import ReactDOM from 'react-dom/client';
import { MantineProvider, createTheme } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './styles.css';
import { AuthProvider } from './auth';
import { App } from './App';

const theme = createTheme({
  primaryColor: 'orange',
  primaryShade: 7,
  fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  headings: { fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
  defaultRadius: 'md',
  colors: {
    orange: ['#fff3e9', '#ffdfc7', '#ffbd91', '#fa9a5c', '#f57a30', '#e96517', '#d8550d', '#bd4509', '#a33806', '#862d06'],
  },
});

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: true } },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MantineProvider theme={theme}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthProvider><App /></AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
      <Notifications position="top-right" />
    </MantineProvider>
  </React.StrictMode>,
);
