// Explicit icon registry so the bundle only ships the icons the nav actually uses.
import { BookText, Boxes, Building2, Circle, Layers, LayoutDashboard, Package, Settings, SlidersHorizontal, UserCog, Users, Wallet, type LucideIcon } from 'lucide-react';

export const ICONS: Record<string, LucideIcon> = { BookText, Boxes, Building2, Layers, LayoutDashboard, Package, Settings, SlidersHorizontal, UserCog, Users, Wallet };

export function Icon({ name, className }: { name?: string; className?: string }) {
  const C = (name && ICONS[name]) || Circle;
  return <C className={className} />;
}
