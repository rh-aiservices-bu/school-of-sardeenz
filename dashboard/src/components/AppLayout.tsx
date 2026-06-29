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
import { useTranslation } from 'react-i18next';

interface AppLayoutProps {
  children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation('common');

  const masthead = (
    <Masthead>
      <MastheadMain>
        <MastheadBrand>{t('brand')}</MastheadBrand>
      </MastheadMain>
    </Masthead>
  );

  const sidebar = (
    <PageSidebar>
      <PageSidebarBody>
        <Nav>
          <NavList>
            <NavItem itemId="/" isActive={location.pathname === '/'} onClick={() => navigate('/')}>
              {t('nav.clusterOverview')}
            </NavItem>
            <NavItem
              itemId="/models"
              isActive={location.pathname.startsWith('/models')}
              onClick={() => navigate('/models')}
            >
              {t('nav.models')}
            </NavItem>
            <NavItem
              itemId="/workers"
              isActive={location.pathname.startsWith('/workers')}
              onClick={() => navigate('/workers')}
            >
              {t('nav.workers')}
            </NavItem>
            <NavItem
              itemId="/metrics"
              isActive={location.pathname.startsWith('/metrics')}
              onClick={() => navigate('/metrics')}
            >
              {t('nav.metrics')}
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
