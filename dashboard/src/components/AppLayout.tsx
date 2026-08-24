import { ReactNode, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Page,
  Masthead,
  MastheadMain,
  MastheadToggle,
  MastheadBrand,
  MastheadLogo,
  MastheadContent,
  PageSidebar,
  PageSidebarBody,
  Nav,
  NavList,
  NavItem,
  Toolbar,
  ToolbarContent,
  ToolbarGroup,
  ToolbarItem,
  ToggleGroup,
  ToggleGroupItem,
  Dropdown,
  DropdownItem,
  DropdownList,
  MenuToggle,
  Brand,
  Button,
  Content,
  ContentVariants,
  Flex,
  FlexItem,
} from '@patternfly/react-core';
import { BarsIcon, SunIcon, MoonIcon, UserIcon } from '@patternfly/react-icons';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../contexts/ThemeContext';
import { useNotifications } from '../contexts/NotificationContext';
import { useAuth } from '../contexts/AuthContext';
import {
  sardeenzIcon,
  sardeenzLogo,
  githubLogo,
  githubLogoWhite,
  starLogo,
  starLogoWhite,
  forkLogo,
  forkLogoWhite,
} from '../assets';
import { NotificationDrawer, NotificationBadgeButton } from './NotificationDrawer';
import { AlertToastGroup } from './AlertToastGroup';

interface AppLayoutProps {
  children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation('common');
  const { isDarkTheme, setDarkTheme } = useTheme();
  const { toastNotifications, removeToastNotification, unreadCount } = useNotifications();
  const { user, authMode, logout } = useAuth();

  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isUserDropdownOpen, setIsUserDropdownOpen] = useState(false);
  const [repoStars, setRepoStars] = useState<number | null>(null);
  const [repoForks, setRepoForks] = useState<number | null>(null);

  useEffect(() => {
    fetch('https://api.github.com/repos/rh-aiservices-bu/school-of-sardeenz')
      .then((res) => res.json())
      .then((data: { stargazers_count?: number; forks_count?: number }) => {
        setRepoStars(data.stargazers_count ?? null);
        setRepoForks(data.forks_count ?? null);
      })
      .catch(() => {});
  }, []);

  const onUserDropdownToggle = () => {
    setIsUserDropdownOpen(!isUserDropdownOpen);
  };

  const onUserDropdownSelect = () => {
    setIsUserDropdownOpen(false);
  };

  const headerToolbar = (
    <Toolbar isFullHeight isStatic>
      <ToolbarContent>
        <ToolbarGroup
          variant="action-group-plain"
          align={{ default: 'alignEnd' }}
          gap={{ default: 'gapMd' }}
        >
          {/* Theme Toggle */}
          <ToolbarItem>
            <ToggleGroup aria-label={t('theme.toggle')}>
              <ToggleGroupItem
                icon={<SunIcon />}
                aria-label={t('theme.light')}
                isSelected={!isDarkTheme}
                onChange={() => setDarkTheme(false)}
              />
              <ToggleGroupItem
                icon={<MoonIcon />}
                aria-label={t('theme.dark')}
                isSelected={isDarkTheme}
                onChange={() => setDarkTheme(true)}
              />
            </ToggleGroup>
          </ToolbarItem>

          {/* Notification Badge */}
          <ToolbarItem>
            <NotificationBadgeButton
              onClick={() => setIsDrawerOpen(!isDrawerOpen)}
              unreadCount={unreadCount}
            />
          </ToolbarItem>

          {/* User Dropdown */}
          <ToolbarItem>
            <Dropdown
              isOpen={isUserDropdownOpen}
              onSelect={onUserDropdownSelect}
              onOpenChange={(isOpen: boolean) => setIsUserDropdownOpen(isOpen)}
              popperProps={{ position: 'right' }}
              toggle={(toggleRef) => (
                <MenuToggle
                  ref={toggleRef}
                  onClick={onUserDropdownToggle}
                  isExpanded={isUserDropdownOpen}
                  icon={<UserIcon />}
                >
                  {user?.username || 'User'}
                  {user?.roles?.includes('admin')
                    ? ' (admin)'
                    : user?.roles?.includes('admin-readonly')
                      ? ' (admin-readonly)'
                      : ''}
                </MenuToggle>
              )}
            >
              <DropdownList>
                <DropdownItem
                  key="logout"
                  isDisabled={authMode === 'none'}
                  onClick={() => {
                    logout();
                    onUserDropdownSelect();
                  }}
                >
                  {t('userMenu.logout')}
                </DropdownItem>
              </DropdownList>
            </Dropdown>
          </ToolbarItem>
        </ToolbarGroup>
      </ToolbarContent>
    </Toolbar>
  );

  const masthead = (
    <Masthead>
      <MastheadMain>
        <MastheadToggle>
          <Button
            variant="plain"
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            aria-label="Global navigation"
          >
            <BarsIcon />
          </Button>
        </MastheadToggle>
        <MastheadBrand>
          <MastheadLogo style={{ display: 'flex', alignItems: 'center' }}>
            <img src={sardeenzIcon} alt="" style={{ height: '36px', marginRight: '0.5rem' }} />
            <Brand src={sardeenzLogo} alt="Sardeenz" heights={{ default: '36px' }} />
          </MastheadLogo>
        </MastheadBrand>
      </MastheadMain>
      <MastheadContent>{headerToolbar}</MastheadContent>
    </Masthead>
  );

  const sidebar = (
    <PageSidebar isSidebarOpen={isSidebarOpen}>
      <PageSidebarBody
        isFilled
        style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
      >
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
              itemId="/gpu-memory"
              isActive={location.pathname.startsWith('/gpu-memory')}
              onClick={() => navigate('/gpu-memory')}
            >
              {t('nav.gpuMemory')}
            </NavItem>
            <NavItem
              itemId="/catalog"
              isActive={location.pathname.startsWith('/catalog')}
              onClick={() => navigate('/catalog')}
            >
              {t('nav.catalog')}
            </NavItem>
            <NavItem
              itemId="/metrics"
              isActive={location.pathname.startsWith('/metrics')}
              onClick={() => navigate('/metrics')}
            >
              {t('nav.metrics')}
            </NavItem>
            <NavItem
              itemId="/playground"
              isActive={location.pathname.startsWith('/playground')}
              onClick={() => navigate('/playground')}
            >
              {t('nav.playground')}
            </NavItem>
          </NavList>
        </Nav>
        <aside
          role="complementary"
          style={{ marginTop: 'auto', padding: '1rem', textAlign: 'center' }}
        >
          <Content component={ContentVariants.small}>
            {'App by '}
            <a href="http://red.ht/cai-team" target="_blank" rel="noreferrer">
              red.ht/cai team
            </a>
            <br />
            <FlexItem style={{ marginTop: '0.5rem' }}>Version {__APP_VERSION__}</FlexItem>
            <Flex direction={{ default: 'column' }} style={{ width: '100%', alignItems: 'center' }}>
              <FlexItem style={{ marginBottom: '0rem' }}>
                <Flex direction={{ default: 'row' }} alignItems={{ default: 'alignItemsCenter' }}>
                  <FlexItem>
                    <Content
                      component={ContentVariants.a}
                      href="https://github.com/rh-aiservices-bu/school-of-sardeenz"
                      target="_blank"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        marginTop: '0.5rem',
                        fontSize: 'var(--pf-t--global--font--size--xs)',
                      }}
                    >
                      <img
                        src={isDarkTheme ? githubLogoWhite : githubLogo}
                        alt="GitHub logo"
                        style={{ height: '20px', marginRight: '0.5rem' }}
                      />
                      {t('sidebar.sourceOnGitHub')}
                    </Content>
                  </FlexItem>
                </Flex>
              </FlexItem>
              <FlexItem>
                <Flex direction={{ default: 'row' }}>
                  <FlexItem style={{ alignmentBaseline: 'middle' }}>
                    <img
                      src={isDarkTheme ? starLogoWhite : starLogo}
                      alt=""
                      style={{ height: '15px', marginRight: '0.5rem', verticalAlign: 'text-top' }}
                      aria-hidden="true"
                    />
                    <span className="pf-v6-screen-reader">Stars</span>
                    {repoStars !== null ? `${repoStars}` : '-'}
                  </FlexItem>
                  <FlexItem>
                    <img
                      src={isDarkTheme ? forkLogoWhite : forkLogo}
                      alt=""
                      style={{ height: '15px', marginRight: '0.5rem', verticalAlign: 'text-top' }}
                      aria-hidden="true"
                    />
                    <span className="pf-v6-screen-reader">Forks</span>
                    {repoForks !== null ? `${repoForks}` : '-'}
                  </FlexItem>
                </Flex>
              </FlexItem>
            </Flex>
          </Content>
        </aside>
      </PageSidebarBody>
    </PageSidebar>
  );

  return (
    <>
      <AlertToastGroup notifications={toastNotifications} onRemove={removeToastNotification} />
      <Page
        masthead={masthead}
        sidebar={sidebar}
        notificationDrawer={<NotificationDrawer />}
        isNotificationDrawerExpanded={isDrawerOpen}
      >
        {children}
      </Page>
    </>
  );
}
