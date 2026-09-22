// Explicit icon registry so the bundle only ships the icons the nav actually uses.
import { Boxes, Building2, Circle, LayoutDashboard, Settings, SlidersHorizontal, Tags, UserCog, Users, type LucideIcon } from 'lucide-react';

export const ICONS: Record<string, LucideIcon> = { Boxes, Building2, LayoutDashboard, Settings, SlidersHorizontal, Tags, UserCog, Users };

export function Icon({ name, className }: { name?: string; className?: string }) {
  const C = (name && ICONS[name]) || Circle;
  return <C className={className} />;
}
