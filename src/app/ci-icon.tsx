import { Icon } from "@iconify/react/offline";
import building from "@iconify-icons/lucide/building-2";
import door from "@iconify-icons/lucide/door-open";
import server from "@iconify-icons/lucide/server";
import hardDrive from "@iconify-icons/lucide/hard-drive";
import monitor from "@iconify-icons/lucide/monitor";
import appWindow from "@iconify-icons/lucide/app-window";
import packageIcon from "@iconify-icons/lucide/package";
import packageCheck from "@iconify-icons/lucide/package-check";
import settings from "@iconify-icons/lucide/settings-2";
import network from "@iconify-icons/lucide/network";
import type { CIType } from "@/lib/model";

const icons = {
  Site: building,
  Room: door,
  Rack: server,
  Device: hardDrive,
  VirtualMachine: monitor,
  Application: appWindow,
  Software: packageIcon,
  SoftwarePackage: packageCheck,
  Service: settings,
  Network: network,
} satisfies Record<CIType, typeof building>;

export function CIIcon({ type }: { type: CIType }) {
  return <Icon icon={icons[type]} className="ci-icon" aria-hidden="true" ssr />;
}
