import { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Page,
  Masthead,
  MastheadMain,
  MastheadBrand,
  PageSidebar,
  PageSidebarBody,
  Nav,
  NavList,
  NavItem,
} from '@patternfly/react-core';

interface AppLayoutProps {
  children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();

  const masthead = (
    <Masthead>
      <MastheadMain>
        <MastheadBrand>Sardeenz</MastheadBrand>
      </MastheadMain>
    </Masthead>
  );

  const sidebar = (
    <PageSidebar>
      <PageSidebarBody>
        <Nav>
          <NavList>
            <NavItem itemId="/" isActive={location.pathname === '/'} onClick={() => navigate('/')}>
              Cluster Overview
            </NavItem>
            <NavItem
              itemId="/models"
              isActive={location.pathname.startsWith('/models')}
              onClick={() => navigate('/models')}
            >
              Models
            </NavItem>
            <NavItem
              itemId="/workers"
              isActive={location.pathname.startsWith('/workers')}
              onClick={() => navigate('/workers')}
            >
              Workers
            </NavItem>
            <NavItem
              itemId="/metrics"
              isActive={location.pathname.startsWith('/metrics')}
              onClick={() => navigate('/metrics')}
            >
              Metrics
            </NavItem>
          </NavList>
        </Nav>
      </PageSidebarBody>
    </PageSidebar>
  );

  return (
    <Page masthead={masthead} sidebar={sidebar}>
      {children}
    </Page>
  );
}
