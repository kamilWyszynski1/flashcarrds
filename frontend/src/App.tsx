import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { ToastHost } from './components/Sheet';
import { StoreProvider } from './lib/store';
import { AllCards } from './screens/AllCards';
import { Capture } from './screens/Capture';
import { GroupDetail } from './screens/GroupDetail';
import { Home } from './screens/Home';
import { Review } from './screens/Review';
import { Settings } from './screens/Settings';
import { Study } from './screens/Study';
import { Summary } from './screens/Summary';
import { SheetHost } from './sheets/Sheets';

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

export function App() {
  return (
    <BrowserRouter>
      <StoreProvider>
        <ScrollToTop />
        <datalist id="lang-suggestions">
          {['Español', 'Polski', 'English', 'Deutsch', 'Français', 'Italiano', 'Português'].map((l) => (
            <option key={l} value={l} />
          ))}
        </datalist>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/all" element={<AllCards />} />
          <Route path="/capture" element={<Capture />} />
          <Route path="/review" element={<Review />} />
          <Route path="/group/:id" element={<GroupDetail />} />
          <Route path="/study" element={<Study />} />
          <Route path="/summary" element={<Summary />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <SheetHost />
        <ToastHost />
      </StoreProvider>
    </BrowserRouter>
  );
}
