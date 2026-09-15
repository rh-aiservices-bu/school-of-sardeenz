import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from 'react';
import { api, type Notification } from '../api/client';

export interface ToastNotification {
  id: string;
  title: string;
  description?: string;
  variant: 'success' | 'warning' | 'danger' | 'info';
  timeout?: number;
}

interface NotificationContextType {
  notifications: Notification[];
  toastNotifications: ToastNotification[];
  unreadCount: number;
  historyError: boolean;
  addNotification: (notification: Notification) => void;
  markAsRead: (id: string) => void;
  markAllAsRead: () => void;
  removeNotification: (id: string) => void;
  removeToastNotification: (id: string) => void;
  clearAll: () => void;
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined);

export function useNotifications(): NotificationContextType {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error('useNotifications must be used within a NotificationProvider');
  }
  return context;
}

const DEDUP_WINDOW_MS = 500;
const MAX_NOTIFICATIONS = 200; // matches api.notifications.list(200) history fetch below

function logNotificationError(context: string, error: unknown): void {
  console.error(`[notifications] ${context}`, error);
}

interface DedupEntry {
  title: string;
  description?: string;
  timestamp: number;
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [toastNotifications, setToastNotifications] = useState<ToastNotification[]>([]);
  const [historyError, setHistoryError] = useState(false);
  const lastNotificationRef = useRef<DedupEntry | null>(null);

  // Fetch notification history on mount
  useEffect(() => {
    api.notifications
      .list(MAX_NOTIFICATIONS)
      .then((data) => {
        setNotifications(data.notifications);
        setHistoryError(false);
      })
      .catch((error) => {
        setHistoryError(true);
        logNotificationError('failed to load notification history', error);
      });
  }, []);

  const addNotification = useCallback((notification: Notification) => {
    // Deduplication check
    const now = Date.now();
    const lastNotif = lastNotificationRef.current;
    if (lastNotif) {
      const elapsed = now - lastNotif.timestamp;
      if (
        elapsed < DEDUP_WINDOW_MS &&
        lastNotif.title === notification.title &&
        lastNotif.description === notification.description
      ) {
        return; // Duplicate notification, skip
      }
    }
    lastNotificationRef.current = {
      title: notification.title,
      description: notification.description,
      timestamp: now,
    };

    // Add to notifications list
    setNotifications((prev) => [notification, ...prev].slice(0, MAX_NOTIFICATIONS));

    // Create toast notification
    const toast: ToastNotification = {
      id: notification.id,
      title: notification.title,
      description: notification.description,
      variant: notification.variant,
      timeout: 5000,
    };
    setToastNotifications((prev) => [...prev, toast]);
  }, []);

  // Listen for SSE notifications
  useEffect(() => {
    const handler = (event: Event) => {
      const notification = (event as CustomEvent).detail as Notification;
      if (notification) {
        addNotification(notification);
      }
    };
    window.addEventListener('sardeenz:notification', handler);
    return () => window.removeEventListener('sardeenz:notification', handler);
  }, [addNotification]);

  const markAsRead = useCallback((id: string) => {
    api.notifications
      .markRead(id)
      .catch((error) => logNotificationError('failed to mark notification read', error));
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)));
  }, []);

  const markAllAsRead = useCallback(() => {
    api.notifications
      .markAllRead()
      .catch((error) => logNotificationError('failed to mark all notifications read', error));
    setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
  }, []);

  const removeNotification = useCallback((id: string) => {
    api.notifications
      .remove(id)
      .catch((error) => logNotificationError('failed to remove notification', error));
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const removeToastNotification = useCallback((id: string) => {
    setToastNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const clearAll = useCallback(() => {
    api.notifications
      .clearAll()
      .catch((error) => logNotificationError('failed to clear notifications', error));
    setNotifications([]);
  }, []);

  const unreadCount = notifications.filter((n) => !n.isRead).length;

  return (
    <NotificationContext.Provider
      value={{
        notifications,
        toastNotifications,
        unreadCount,
        historyError,
        addNotification,
        markAsRead,
        markAllAsRead,
        removeNotification,
        removeToastNotification,
        clearAll,
      }}
    >
      {children}
    </NotificationContext.Provider>
  );
}
