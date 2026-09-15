import { createContext, type ComponentProps, type ReactNode, useContext } from "react";
import {
  Form as RouterForm,
  Link as RouterLink,
  NavLink as RouterNavLink,
  useLocation,
} from "react-router";
import { PORTAL_CONTEXT_PARAM, portalContextualPath } from "../lib/portal-session-context";

const PortalContext = createContext<string | null>(null);

export function PortalSessionBoundary({ contextId, children }: { contextId: string; children: ReactNode }) {
  return <PortalContext.Provider value={contextId}>{children}</PortalContext.Provider>;
}

export function usePortalContextId(): string {
  const contextId = useContext(PortalContext);
  if (!contextId) throw new Error("客户门户导航缺少窗口上下文");
  return contextId;
}

function useContextualPath(to: string): string {
  const contextId = usePortalContextId();
  const location = useLocation();
  return portalContextualPath(to, contextId, `${location.pathname}${location.search}`);
}

export function PortalLink({ to, ...props }: Omit<ComponentProps<typeof RouterLink>, "to"> & { to: string }) {
  return <RouterLink {...props} to={useContextualPath(to)} />;
}

export function PortalNavLink({ to, ...props }: Omit<ComponentProps<typeof RouterNavLink>, "to"> & { to: string }) {
  return <RouterNavLink {...props} to={useContextualPath(to)} />;
}

export function PortalForm({ action, children, ...props }: ComponentProps<typeof RouterForm>) {
  const location = useLocation();
  const contextId = usePortalContextId();
  const target = typeof action === "string" ? action : `${location.pathname}${location.search}`;
  const contextualAction = portalContextualPath(target, contextId, `${location.pathname}${location.search}`);
  return (
    <RouterForm {...props} action={contextualAction}>
      <input type="hidden" name={PORTAL_CONTEXT_PARAM} value={contextId} />
      {children}
    </RouterForm>
  );
}

export function usePortalHref(to: string): string {
  return useContextualPath(to);
}
