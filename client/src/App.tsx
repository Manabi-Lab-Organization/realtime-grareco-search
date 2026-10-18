import { Switch, Route, Redirect } from 'wouter';
import { rememberNext, takeNext, resolvePostLoginPath, isSafeNextPath } from '@/lib/postLoginRedirect';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/queryClient';
import { useAuth } from './hooks/use-auth';
import { Toaster } from './components/ui/toaster';
import { ConfirmProvider } from './components/ui/confirm-dialog';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import ChangePasswordPage from './pages/ChangePasswordPage';
import DashboardPage from './pages/DashboardPage';
import MeetingDetailPageV2 from './pages/MeetingDetailPageV2';
import DownloadPage from './pages/DownloadPage';
import MyPage from './pages/MyPage';
import SharedMeetingPage from './pages/SharedMeetingPage';
import AdminPage from './pages/AdminPage';
import GuidePage from './pages/GuidePage';
import TroubleshootPage from './pages/TroubleshootPage';
import ChangelogPage from './pages/ChangelogPage';
import AnnouncementsPage from './pages/AnnouncementsPage';
import { AnnouncementsModalGlobal } from './components/announcements/AnnouncementsModalGlobal';
import { StartupModalQueue } from './components/startup/StartupModalQueue';
import { ReauthDialog } from './components/account/ReauthDialog';
import { Footer } from './components/layout/Footer';

function GlobalModals() {
  return (
    <StartupModalQueue>
      <AnnouncementsModalGlobal />
    </StartupModalQueue>
  );
}

function ProtectedRoute({
  component: Component,
  requireAdminRole = false,
}: {
  component: React.ComponentType;
  requireAdminRole?: boolean;
}) {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!user) {
    const here = window.location.pathname + window.location.search;
    rememberNext(here);
    const next = isSafeNextPath(here) ? `?next=${encodeURIComponent(here)}` : '';
    return <Redirect to={`/login${next}`} />;
  }
  if (requireAdminRole && user.role !== 'admin') return <Redirect to="/" />;

  const pending = resolvePostLoginPath({
    search: window.location.search,
    currentPath: window.location.pathname + window.location.search,
    stored: takeNext(),
  });
  if (pending) return <Redirect to={pending} />;

  return <Component />;
}

function RecordRedirect() {
  const match = window.location.pathname.match(/\/(record|recorder)\/(\d+)/);
  const id = match?.[2] || "0";
  return <Redirect to={`/meetings/${id}`} />;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ConfirmProvider>
      <div className="min-h-screen flex flex-col">
      <div className="flex-1">
      <Switch>
        <Route path="/share/:token" component={SharedMeetingPage} />
        <Route path="/login" component={LoginPage} />
        <Route path="/guide" component={GuidePage} />
        <Route path="/troubleshooting" component={TroubleshootPage} />
        <Route path="/changelog" component={ChangelogPage} />
        <Route path="/register" component={RegisterPage} />
        <Route path="/forgot-password" component={ForgotPasswordPage} />
        <Route path="/reset-password" component={ResetPasswordPage} />
        <Route path="/mypage" component={() => <ProtectedRoute component={MyPage} />} />
        <Route path="/change-password" component={() => <ProtectedRoute component={ChangePasswordPage} />} />
        <Route path="/announcements" component={() => <ProtectedRoute component={AnnouncementsPage} />} />
        <Route path="/admin" component={() => <ProtectedRoute component={AdminPage} requireAdminRole />} />
        <Route path="/" component={() => <ProtectedRoute component={DashboardPage} />} />
        <Route path="/record/:id" component={RecordRedirect} />
        <Route path="/recorder/:id" component={RecordRedirect} />
        <Route path="/download" component={() => <ProtectedRoute component={DownloadPage} />} />
        <Route path="/meetings/:id" component={() => <ProtectedRoute component={MeetingDetailPageV2} />} />
        <Route component={() => <Redirect to="/" />} />
      </Switch>
      </div>
      <Footer />
      </div>
      <Toaster />
      <GlobalModals />
      <ReauthDialog />
      </ConfirmProvider>
    </QueryClientProvider>
  );
}
