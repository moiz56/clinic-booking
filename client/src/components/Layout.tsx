import { Link, NavLink, Outlet } from 'react-router-dom';
import ThemeToggle from './ThemeToggle';

export default function Layout() {
  return (
    <div className="site">
      <header className="site-header">
        <div className="container header-row">
          <Link to="/" className="brand">
            <span className="brand-mark">📅</span> Book<span className="brand-accent">It</span>
          </Link>
          <nav className="site-nav">
            <NavLink to="/manage" className="nav-pill">Manage booking</NavLink>
            <ThemeToggle />
          </nav>
        </div>
      </header>
      <main className="site-main">
        <Outlet />
      </main>
      <footer className="site-footer">
        <div className="container footer-row">
          <span>BookIt — Appointment Booking System</span>
          <Link to="/admin">Admin panel →</Link>
        </div>
      </footer>
    </div>
  );
}
