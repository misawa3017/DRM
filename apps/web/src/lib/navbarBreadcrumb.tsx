import {
  createContext,
  useContext,
  useEffect,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';

interface NavbarBreadcrumbContextValue {
  crumb: ReactNode;
  setCrumb: Dispatch<SetStateAction<ReactNode>>;
}

export const NavbarBreadcrumbContext = createContext<NavbarBreadcrumbContextValue>({
  crumb: null,
  setCrumb: () => {},
});

export function useSetNavbarCrumb(node: ReactNode): void {
  const { setCrumb } = useContext(NavbarBreadcrumbContext);
  useEffect(() => {
    setCrumb(node);
    return () => setCrumb((current) => (current === node ? null : current));
  }, [node, setCrumb]);
}
