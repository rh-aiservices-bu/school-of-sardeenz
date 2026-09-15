import { useState } from 'react';
import {
  NotificationDrawer as PFNotificationDrawer,
  NotificationDrawerBody,
  NotificationDrawerHeader,
  NotificationDrawerList,
  NotificationDrawerListItem,
  NotificationDrawerListItemBody,
  NotificationDrawerListItemHeader,
  Alert,
  EmptyState,
  EmptyStateBody,
  EmptyStateVariant,
  Button,
  NotificationBadge,
  Dropdown,
  DropdownItem,
  DropdownList,
  MenuToggle,
} from '@patternfly/react-core';
import { BellIcon, EllipsisVIcon } from '@patternfly/react-icons';
import { useTranslation } from 'react-i18next';
import { useNotifications } from '../contexts/NotificationContext';

export function NotificationDrawer() {
  const { t } = useTranslation('common');
  const { notifications, historyError, markAsRead, markAllAsRead, removeNotification, clearAll } =
    useNotifications();
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  const unreadCount = notifications.filter((n) => !n.isRead).length;

  const onDropdownSelect = () => {
    setIsDropdownOpen(false);
  };

  const onDropdownToggle = () => {
    setIsDropdownOpen(!isDropdownOpen);
  };

  const notificationDrawerActions = (
    <>
      <DropdownItem key="markAllRead" onClick={markAllAsRead}>
        {t('notifications.markAllRead')}
      </DropdownItem>
      <DropdownItem key="clearAll" onClick={clearAll}>
        {t('notifications.clearAll')}
      </DropdownItem>
    </>
  );

  const getVariantIcon = (variant?: string) => {
    switch (variant) {
      case 'success':
        return '✓';
      case 'warning':
        return '⚠';
      case 'danger':
        return '✕';
      case 'info':
        return 'ℹ';
      default:
        return '•';
    }
  };

  return (
    <PFNotificationDrawer role="region" aria-label={t('notifications.title')}>
      <NotificationDrawerHeader count={unreadCount} title={t('notifications.title')}>
        <Dropdown
          id="notification-drawer-actions"
          isOpen={isDropdownOpen}
          onSelect={onDropdownSelect}
          popperProps={{ position: 'right', appendTo: 'inline' }}
          onOpenChange={(isOpen: boolean) => !isOpen && setIsDropdownOpen(false)}
          toggle={(toggleRef) => (
            <MenuToggle
              ref={toggleRef}
              isExpanded={isDropdownOpen}
              variant="plain"
              onClick={onDropdownToggle}
              aria-label={t('notifications.actions')}
              icon={<EllipsisVIcon />}
            />
          )}
        >
          <DropdownList>{notificationDrawerActions}</DropdownList>
        </Dropdown>
      </NotificationDrawerHeader>
      <NotificationDrawerBody>
        {historyError && (
          <Alert
            variant="danger"
            isInline
            title={t('notifications.loadError')}
            className="pf-v6-u-mb-md"
          />
        )}
        {notifications.length === 0 ? (
          <EmptyState variant={EmptyStateVariant.sm} titleText={t('notifications.noNotifications')}>
            <BellIcon
              style={{
                fontSize: 'var(--pf-t--global--font--size--3xl)',
                color: 'var(--pf-t--global--text--color--subtle)',
              }}
            />
            <EmptyStateBody>{t('notifications.noNotificationsBody')}</EmptyStateBody>
          </EmptyState>
        ) : (
          <NotificationDrawerList>
            {notifications.map((notification) => (
              <NotificationDrawerListItem
                key={notification.id}
                variant={notification.variant}
                isRead={notification.isRead}
                onClick={() => markAsRead(notification.id)}
              >
                <NotificationDrawerListItemHeader
                  variant={notification.variant}
                  title={notification.title}
                  srTitle="Notification"
                >
                  <Button
                    variant="plain"
                    aria-label={`Remove notification: ${notification.title}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeNotification(notification.id);
                    }}
                  >
                    ×
                  </Button>
                </NotificationDrawerListItemHeader>
                <NotificationDrawerListItemBody
                  timestamp={new Date(notification.timestamp).toLocaleString()}
                >
                  {notification.description && (
                    <div style={{ marginTop: '0.5rem' }}>
                      {getVariantIcon(notification.variant)} {notification.description}
                    </div>
                  )}
                </NotificationDrawerListItemBody>
              </NotificationDrawerListItem>
            ))}
          </NotificationDrawerList>
        )}
      </NotificationDrawerBody>
    </PFNotificationDrawer>
  );
}

interface NotificationBadgeButtonProps {
  onClick: () => void;
  unreadCount: number;
}

export function NotificationBadgeButton({ onClick, unreadCount }: NotificationBadgeButtonProps) {
  const { t } = useTranslation('common');
  return (
    <NotificationBadge
      count={unreadCount}
      onClick={onClick}
      aria-label={t('notifications.title')}
    />
  );
}
