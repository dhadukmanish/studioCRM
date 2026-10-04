import { Navigate, Route, Routes } from 'react-router-dom';
import { DEFAULT_DISPLAY_FORMATS, FixedDisplayFormatsProvider } from '@/lib/settings';
import PlatformLayout from './PlatformLayout';
import PlatformSignIn from './PlatformSignIn';
import StudiosPage from './StudiosPage';
import StudioDetailPage from './StudioDetailPage';
import PlansPage from './PlansPage';

/**
 * The SaaS platform panel, mounted at /platform/* and lazy-loaded as its own chunk. It shares the
 * web build and API with the studio app but nothing of the studio session: its own sign-in, token
 * (store/platformAuth.ts), API client (lib/platformApi.ts) and layout. The platform has no tenant
 * settings, so dates use the product default format.
 */
export default function PlatformApp() {
  return (
    <FixedDisplayFormatsProvider value={DEFAULT_DISPLAY_FORMATS}>
      <Routes>
        <Route path="signin" element={<PlatformSignIn />} />
        <Route element={<PlatformLayout />}>
          <Route index element={<StudiosPage />} />
          <Route path="studios/:id" element={<StudioDetailPage />} />
          <Route path="plans" element={<PlansPage />} />
          <Route path="*" element={<Navigate to="/platform" replace />} />
        </Route>
      </Routes>
    </FixedDisplayFormatsProvider>
  );
}
