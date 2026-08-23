import {
  Archive,
  BadgeDollarSign,
  Boxes,
  BriefcaseBusiness,
  Building2,
  ChartNoAxesCombined,
  ChevronDown,
  ClipboardCheck,
  ClipboardList,
  FileSearch,
  FileText,
  Gauge,
  History,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  MapPinned,
  PackageCheck,
  PanelsTopLeft,
  ReceiptText,
  Search,
  Settings2,
  ShieldCheck,
  Truck,
  UserRoundCog,
  UsersRound,
  Warehouse,
  Workflow,
  type LucideIcon,
} from "lucide-react";

const icons = {
  archive: Archive,
  billing: BadgeDollarSign,
  boxes: Boxes,
  briefcase: BriefcaseBusiness,
  building: Building2,
  chart: ChartNoAxesCombined,
  chevronDown: ChevronDown,
  clipboardCheck: ClipboardCheck,
  clipboard: ClipboardList,
  dashboard: Gauge,
  documents: FileSearch,
  file: FileText,
  history: History,
  layout: LayoutDashboard,
  lock: LockKeyhole,
  logout: LogOut,
  map: MapPinned,
  packageCheck: PackageCheck,
  panels: PanelsTopLeft,
  receipt: ReceiptText,
  search: Search,
  settings: Settings2,
  shield: ShieldCheck,
  truck: Truck,
  userSettings: UserRoundCog,
  users: UsersRound,
  warehouse: Warehouse,
  workflow: Workflow,
} satisfies Record<string, LucideIcon>;

export type AppIconName = keyof typeof icons;

export function AppIcon({
  name,
  size = 18,
  strokeWidth = 1.8,
  className,
}: {
  name: AppIconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
}) {
  const Icon = icons[name];
  return (
    <Icon
      aria-hidden="true"
      className={className}
      size={size}
      strokeWidth={strokeWidth}
    />
  );
}
