import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Booking from './pages/Booking';
import Confirmation from './pages/Confirmation';
import Manage from './pages/Manage';
import AdminLogin from './admin/AdminLogin';
import AdminLayout from './admin/AdminLayout';
import Dashboard from './admin/Dashboard';
import AdminBookings from './admin/Bookings';
import DayView from './admin/DayView';
import WeekView from './admin/WeekView';
import Settings from './admin/Settings';
import AdminReviews from './admin/Reviews';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Booking />} />
        <Route path="/confirmation" element={<Confirmation />} />
        <Route path="/manage" element={<Manage />} />
      </Route>
      <Route path="/admin/login" element={<AdminLogin />} />
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<Dashboard />} />
        <Route path="bookings" element={<AdminBookings />} />
        <Route path="day" element={<DayView />} />
        <Route path="week" element={<WeekView />} />
        <Route path="settings" element={<Settings />} />
        <Route path="reviews" element={<AdminReviews />} />
      </Route>
    </Routes>
  );
}
