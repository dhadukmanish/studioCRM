import { Link, useLocation } from 'react-router-dom';
import { Construction } from 'lucide-react';

export function ComingSoon({ title }: { title?: string }) {
  const { pathname } = useLocation();
  const name = title ?? pathname.split('/').filter(Boolean).slice(-1)[0]?.replace(/-/g, ' ');
  return (
    <div className="card flex flex-col items-center justify-center py-24 text-center">
      <Construction className="h-10 w-10 text-gray-300" />
      <h3 className="mt-3 text-[18px] font-semibold capitalize text-gray-800">{name}</h3>
      <p className="mt-1 text-[13px] text-gray-500">This module is part of the next build phase.</p>
    </div>
  );
}

export function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <div className="font-heading text-[64px] font-semibold text-gray-200">404</div>
      <p className="text-[15px] text-gray-600">The page you are looking for doesn't exist.</p>
      <Link to="/dashboard" className="btn-primary mt-5">Go to Home</Link>
    </div>
  );
}
