import {
  doc,
  setDoc,
  onSnapshot,
  collection,
  query,
  orderBy,
  limit,
  addDoc,
  serverTimestamp
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import { SharedSettings, DEFAULT_SHARED_SETTINGS, ActivityLogItem } from '../types/cloudSync';
import { SignalOrderLog } from '../components/SignalTrader';

const SETTINGS_DOC_PATH = 'workspaces/global/settings/config';

// 1. Subscribe to shared settings & safety locks
export function subscribeToSharedSettings(
  onUpdate: (settings: SharedSettings) => void,
  onError?: (err: any) => void
) {
  try {
    const docRef = doc(db, 'workspaces', 'global', 'settings', 'config');
    return onSnapshot(
      docRef,
      (snapshot) => {
        if (snapshot.exists()) {
          const data = snapshot.data() as SharedSettings;
          onUpdate({ ...DEFAULT_SHARED_SETTINGS, ...data });
        } else {
          // Initialize default settings in cloud if doc doesn't exist
          setDoc(docRef, { ...DEFAULT_SHARED_SETTINGS, updatedAt: new Date().toISOString() }).catch(() => {});
          onUpdate(DEFAULT_SHARED_SETTINGS);
        }
      },
      (error) => {
        handleFirestoreError(error, OperationType.GET, SETTINGS_DOC_PATH);
        if (onError) onError(error);
      }
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, SETTINGS_DOC_PATH);
    return () => {};
  }
}

// 2. Save/Update shared settings & safety locks
export async function saveSharedSettingsToCloud(
  settings: Partial<SharedSettings>,
  operatorName: string = 'Bruno'
): Promise<boolean> {
  try {
    const docRef = doc(db, 'workspaces', 'global', 'settings', 'config');
    await setDoc(
      docRef,
      {
        ...settings,
        updatedAt: new Date().toISOString(),
        updatedBy: operatorName
      },
      { merge: true }
    );
    return true;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, SETTINGS_DOC_PATH);
    return false;
  }
}

// 3. Subscribe to real-time shared signal orders
export function subscribeToSharedOrders(
  onUpdate: (orders: SignalOrderLog[]) => void,
  onError?: (err: any) => void
) {
  try {
    const ordersCol = collection(db, 'signal_orders');
    const q = query(ordersCol, limit(100));

    return onSnapshot(
      q,
      (snapshot) => {
        const items: SignalOrderLog[] = [];
        snapshot.forEach((docSnap) => {
          items.push({ ...(docSnap.data() as SignalOrderLog), id: docSnap.id });
        });
        
        // Sort descending by executedAt
        items.sort((a, b) => {
          const tA = new Date(a.executedAt).getTime() || 0;
          const tB = new Date(b.executedAt).getTime() || 0;
          return tB - tA;
        });

        onUpdate(items);
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, 'signal_orders');
        if (onError) onError(error);
      }
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'signal_orders');
    return () => {};
  }
}

function sanitizeForFirestore(obj: any): any {
  if (obj === undefined) return null;
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeForFirestore);
  const clean: any = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      clean[k] = sanitizeForFirestore(v);
    }
  }
  return clean;
}

// 4. Save an order to cloud
export async function saveOrderToCloud(order: SignalOrderLog): Promise<boolean> {
  try {
    const docRef = doc(db, 'signal_orders', order.id);
    const cleanData = sanitizeForFirestore({
      ...order,
      syncedAt: new Date().toISOString()
    });
    await setDoc(docRef, cleanData);
    return true;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `signal_orders/${order.id}`);
    return false;
  }
}

// 5. Update an order in cloud (e.g. status closed, pnl updated, trailing stop changed)
export async function updateOrderInCloud(orderId: string, updates: Partial<SignalOrderLog>): Promise<boolean> {
  try {
    const docRef = doc(db, 'signal_orders', orderId);
    const cleanUpdates = sanitizeForFirestore(updates);
    await setDoc(docRef, cleanUpdates, { merge: true });
    return true;
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `signal_orders/${orderId}`);
    return false;
  }
}

// 6. Subscribe to audit/activity logs
export function subscribeToActivityLogs(
  onUpdate: (logs: ActivityLogItem[]) => void,
  onError?: (err: any) => void
) {
  try {
    const logsCol = collection(db, 'activity_logs');
    const q = query(logsCol, limit(50));

    return onSnapshot(
      q,
      (snapshot) => {
        const items: ActivityLogItem[] = [];
        snapshot.forEach((docSnap) => {
          items.push({ ...(docSnap.data() as ActivityLogItem), id: docSnap.id });
        });
        items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        onUpdate(items);
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, 'activity_logs');
        if (onError) onError(error);
      }
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'activity_logs');
    return () => {};
  }
}

// 7. Log an activity
export async function logPartnerActivity(
  operator: string,
  action: string,
  details: string,
  type: 'info' | 'success' | 'warning' | 'error' = 'info'
) {
  try {
    const logsCol = collection(db, 'activity_logs');
    await addDoc(logsCol, {
      operator,
      action,
      details,
      type,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    // Non-blocking error logging
    console.warn('Failed to write activity log:', error);
  }
}
