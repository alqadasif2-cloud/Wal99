import { User, Wallet, Transaction, AppNotification } from '../types/wallet';
import { db, handleFirestoreError, OperationType, ensureFirebaseAuth } from './firebase';
import { createDefaultAssets } from './walletDb';
import { 
  collection, 
  doc, 
  getDoc, 
  getDocs, 
  setDoc, 
  query, 
  where, 
  onSnapshot, 
  Unsubscribe,
  runTransaction 
} from 'firebase/firestore';

export interface RecipientLookupResult {
  found: boolean;
  user: User | null;
  wallet: Wallet | null;
  isCloudVerified: boolean;
  error?: string;
}

export function cleanForFirestore<T extends Record<string, any>>(obj: T): any {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(cleanForFirestore);
  const cleaned: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      cleaned[k] = (v && typeof v === 'object' && !(v instanceof Date)) ? cleanForFirestore(v) : v;
    }
  }
  return cleaned;
}

// In-flight idempotency locks
const activeTransferLocks = new Set<string>();

export class WalletCloudService {
  /**
   * Parse any input string (plain address, username, or full URL)
   * Extracts candidate address, username, or URL query parameter.
   */
  public static extractRecipientQuery(input: string): string {
    const raw = (input || '').trim();
    if (!raw) return '';

    // If input is a URL or query string (e.g. https://.../?wallet=0x... or ?to=0x...)
    if (raw.includes('?') || raw.includes('://') || raw.startsWith('/?')) {
      try {
        const urlObj = new URL(raw.startsWith('/') ? `http://localhost${raw}` : raw);
        const candidate = urlObj.searchParams.get('wallet') || 
                          urlObj.searchParams.get('to') || 
                          urlObj.searchParams.get('sendTo') || 
                          urlObj.searchParams.get('address') || 
                          urlObj.searchParams.get('recipient');
        if (candidate) return candidate.trim();
        
        // If path itself contains address like /wallet/0x...
        const pathSegments = urlObj.pathname.split('/').filter(Boolean);
        const lastSegment = pathSegments[pathSegments.length - 1];
        if (lastSegment && lastSegment.startsWith('0x')) {
          return lastSegment.trim();
        }
      } catch {
        const match = raw.match(/[?&](?:wallet|to|sendTo|address)=([^&#]+)/i);
        if (match && match[1]) {
          return decodeURIComponent(match[1]).trim();
        }
      }
    }

    // Strip leading @ if provided as @username
    if (raw.startsWith('@')) {
      return raw.substring(1).trim();
    }

    return raw;
  }

  /**
   * Search Firestore cloud database for a recipient across all devices and phones.
   * Checks both 'users' and 'wallets' collections in Cloud Firestore.
   */
  public static async lookupRecipientCloud(
    input: string, 
    localUsersFallback: User[] = []
  ): Promise<RecipientLookupResult> {
    const cleaned = this.extractRecipientQuery(input);
    if (!cleaned) {
      return { found: false, user: null, wallet: null, isCloudVerified: false };
    }

    await ensureFirebaseAuth();
    const lowerCleaned = cleaned.toLowerCase();

    try {
      const usersCol = collection(db, 'users');
      const walletsCol = collection(db, 'wallets');

      // 1. Direct query on users by demoAddress
      const qAddress = query(usersCol, where('demoAddress', '==', cleaned));
      const snapAddress = await getDocs(qAddress);
      if (!snapAddress.empty) {
        const cloudUser = snapAddress.docs[0].data() as User;
        const cloudWallet = await this.fetchUserWalletCloud(cloudUser.userId);
        return {
          found: true,
          user: cloudUser,
          wallet: cloudWallet,
          isCloudVerified: true
        };
      }

      // 2. Query users by username (exact)
      const qUsername = query(usersCol, where('username', '==', cleaned));
      const snapUsername = await getDocs(qUsername);
      if (!snapUsername.empty) {
        const cloudUser = snapUsername.docs[0].data() as User;
        const cloudWallet = await this.fetchUserWalletCloud(cloudUser.userId);
        return {
          found: true,
          user: cloudUser,
          wallet: cloudWallet,
          isCloudVerified: true
        };
      }

      // 3. Direct document lookup by userId
      try {
        const userDocRef = doc(db, 'users', cleaned);
        const userDocSnap = await getDoc(userDocRef);
        if (userDocSnap.exists()) {
          const cloudUser = userDocSnap.data() as User;
          const cloudWallet = await this.fetchUserWalletCloud(cloudUser.userId);
          return {
            found: true,
            user: cloudUser,
            wallet: cloudWallet,
            isCloudVerified: true
          };
        }
      } catch {}

      // 4. Query wallets collection by demoAddress (in case address is in wallets doc)
      const qWalletByAddr = query(walletsCol, where('demoAddress', '==', cleaned));
      const snapWalletAddr = await getDocs(qWalletByAddr);
      if (!snapWalletAddr.empty) {
        const cloudWallet = snapWalletAddr.docs[0].data() as Wallet;
        const ownerId = cloudWallet.ownerUserId;
        let ownerUser: User | null = null;
        if (ownerId) {
          const ownerDoc = await getDoc(doc(db, 'users', ownerId));
          if (ownerDoc.exists()) {
            ownerUser = ownerDoc.data() as User;
          }
        }
        if (ownerUser) {
          return {
            found: true,
            user: ownerUser,
            wallet: cloudWallet,
            isCloudVerified: true
          };
        }
      }

      // 5. Case-insensitive scan across users in Cloud Firestore
      const allUsersSnap = await getDocs(usersCol);
      if (!allUsersSnap.empty) {
        for (const docSnap of allUsersSnap.docs) {
          const u = docSnap.data() as User;
          if (
            (u.demoAddress && u.demoAddress.toLowerCase() === lowerCleaned) ||
            (u.username && u.username.toLowerCase() === lowerCleaned) ||
            (u.userId && u.userId.toLowerCase() === lowerCleaned) ||
            (u.displayName && u.displayName.toLowerCase() === lowerCleaned)
          ) {
            const cloudWallet = await this.fetchUserWalletCloud(u.userId);
            return {
              found: true,
              user: u,
              wallet: cloudWallet,
              isCloudVerified: true
            };
          }
        }
      }

      // 6. Case-insensitive scan across wallets in Cloud Firestore
      const allWalletsSnap = await getDocs(walletsCol);
      if (!allWalletsSnap.empty) {
        for (const docSnap of allWalletsSnap.docs) {
          const w = docSnap.data() as Wallet;
          if (
            (w.demoAddress && w.demoAddress.toLowerCase() === lowerCleaned) ||
            (w.walletId && w.walletId.toLowerCase() === lowerCleaned)
          ) {
            let ownerUser: User | null = null;
            if (w.ownerUserId) {
              const uDoc = await getDoc(doc(db, 'users', w.ownerUserId));
              if (uDoc.exists()) {
                ownerUser = uDoc.data() as User;
              }
            }
            if (ownerUser) {
              return {
                found: true,
                user: ownerUser,
                wallet: w,
                isCloudVerified: true
              };
            }
          }
        }
      }
    } catch (e) {
      console.warn('[WalletCloudService] Cloud lookup query note:', e);
    }

    // 7. Fallback to local users list (e.g. initial demo accounts if not yet pushed)
    const localMatch = localUsersFallback.find(u => 
      (u.demoAddress && u.demoAddress.toLowerCase() === lowerCleaned) ||
      (u.username && u.username.toLowerCase() === lowerCleaned) ||
      (u.userId && u.userId.toLowerCase() === lowerCleaned)
    );

    if (localMatch) {
      // Proactively sync this user and their wallet to Cloud Firestore so all devices see them
      this.saveUserToCloud(localMatch).catch(() => {});
      return {
        found: true,
        user: localMatch,
        wallet: null,
        isCloudVerified: true
      };
    }

    return {
      found: false,
      user: null,
      wallet: null,
      isCloudVerified: false,
      error: 'لم يتم العثور على صاحب هذا الرابط أو العنوان في قاعدة البيانات المركزية.'
    };
  }

  /**
   * Fetch live wallet directly from Cloud Firestore.
   */
  public static async fetchUserWalletCloud(userId: string): Promise<Wallet | null> {
    if (!userId) return null;
    try {
      await ensureFirebaseAuth();
      // Try doc with userId
      const wDoc = await getDoc(doc(db, 'wallets', userId));
      if (wDoc.exists()) {
        return wDoc.data() as Wallet;
      }
      // Query by ownerUserId
      const q = query(collection(db, 'wallets'), where('ownerUserId', '==', userId));
      const snap = await getDocs(q);
      if (!snap.empty) {
        return snap.docs[0].data() as Wallet;
      }
    } catch (e) {
      console.warn('[WalletCloudService] fetchUserWalletCloud note:', e);
    }
    return null;
  }

  /**
   * Save or update a user and their wallet to Firestore cloud.
   */
  public static async saveUserToCloud(user: User, wallet?: Wallet | null): Promise<void> {
    try {
      await ensureFirebaseAuth();
      const userRef = doc(db, 'users', user.userId);
      await setDoc(userRef, cleanForFirestore({
        ...user,
        updatedAt: new Date().toISOString()
      }), { merge: true });

      if (wallet) {
        const walletRef = doc(db, 'wallets', user.userId);
        await setDoc(walletRef, cleanForFirestore({
          ...wallet,
          ownerUserId: user.userId,
          walletId: wallet.walletId || user.userId,
          updatedAt: new Date().toISOString()
        }), { merge: true });

        // If walletId is different from userId, keep dual doc for backwards compatibility
        if (wallet.walletId && wallet.walletId !== user.userId) {
          const altRef = doc(db, 'wallets', wallet.walletId);
          await setDoc(altRef, cleanForFirestore({
            ...wallet,
            ownerUserId: user.userId,
            updatedAt: new Date().toISOString()
          }), { merge: true });
        }
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `users/${user.userId}`);
    }
  }

  /**
   * Generate a shareable wallet link for receiving funds.
   */
  public static getShareableWalletLink(address: string): string {
    const origin = typeof window !== 'undefined' ? window.location.origin : 'https://trustwallet.pro';
    return `${origin}/?wallet=${encodeURIComponent(address)}`;
  }

  /**
   * Execute an atomic, multi-device transfer via Cloud Firestore Transaction.
   * Atomically verifies sender balance, debits sender, credits recipient,
   * writes transaction ledger entry, and dispatches in-app notification.
   */
  public static async executeCloudSendTransfer(params: {
    sender: User;
    senderWallet: Wallet;
    recipient: User;
    recipientWallet?: Wallet | null;
    amount: number;
    currency?: string;
    lockDurationMinutes?: number;
    notes?: string;
    idempotencyKey?: string;
  }): Promise<{ success: boolean; message: string; transaction?: Transaction; updatedSenderWallet?: Wallet }> {
    const { 
      sender, 
      senderWallet, 
      recipient, 
      amount, 
      currency = 'USD', 
      lockDurationMinutes = 0, 
      notes,
      idempotencyKey 
    } = params;

    const opKey = idempotencyKey || `${sender.userId}_${recipient.userId}_${amount}_${Date.now()}`;
    if (activeTransferLocks.has(opKey)) {
      return { success: false, message: 'عملية التحويل قيد المعالجة بالفعل، يرجى الانتظار.' };
    }
    activeTransferLocks.add(opKey);

    try {
      if (amount <= 0 || isNaN(amount)) {
        return { success: false, message: 'يرجى إدخال مبلغ صحيح أكبر من الصفر.' };
      }

      if (sender.userId === recipient.userId || sender.demoAddress.toLowerCase() === recipient.demoAddress.toLowerCase()) {
        return { success: false, message: 'لا يمكنك إرسال الأموال إلى محفظتك الخاصة.' };
      }

      await ensureFirebaseAuth();

      const now = new Date();
      const nowIso = now.toISOString();
      const isLocked = (lockDurationMinutes || 0) > 0;
      const lockUntil = isLocked ? new Date(now.getTime() + lockDurationMinutes * 60 * 1000).toISOString() : undefined;
      const txId = 'TX_' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
      const notifId = 'NTF_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 5);
      const networkTxHash = '0x' + Array.from({length: 64}, () => Math.floor(Math.random()*16).toString(16)).join('');

      const newTx: Transaction = {
        transactionId: txId,
        senderUserId: sender.userId,
        senderUsername: sender.displayName || sender.username,
        senderAddress: sender.demoAddress,
        receiverUserId: recipient.userId,
        receiverUsername: recipient.displayName || recipient.username,
        receiverAddress: recipient.demoAddress,
        amount,
        currency,
        network: 'BEP20',
        transactionType: 'send',
        status: isLocked ? 'locked' : 'completed',
        statusTextAr: isLocked ? 'قيد التقييد' : 'مكتملة',
        createdAt: nowIso,
        lockUntil,
        lockDurationMinutes: isLocked ? lockDurationMinutes : undefined,
        isSimulated: false,
        notes: notes?.trim() || (isLocked ? `مبلغ مقيد لمدة ${lockDurationMinutes} دقيقة` : undefined),
        networkTxHash
      };

      const senderName = sender.displayName || sender.username;
      const lockNoticeAr = isLocked ? ` (مبلغ مقيد لمدة ${lockDurationMinutes} دقيقة)` : '';
      const notificationPayload: AppNotification = {
        notificationId: notifId,
        recipientUserId: recipient.userId,
        transactionId: txId,
        title: 'تم استلام أموال جديدة',
        titleAr: 'تم استلام أموال جديدة',
        body: `تم استلام مبلغ قدره $${amount.toFixed(2)} من [${senderName}]، وتم تحديث رصيد محفظتك بنجاح${lockNoticeAr}`,
        bodyAr: `تم استلام مبلغ قدره $${amount.toFixed(2)} من [${senderName}]، وتم تحديث رصيد محفظتك بنجاح${lockNoticeAr}`,
        createdAt: nowIso,
        read: false,
        type: isLocked ? 'locked_transfer' : 'incoming_transfer'
      };

      // Document references
      const senderWalletRef = doc(db, 'wallets', sender.userId);
      const recipientWalletRef = doc(db, 'wallets', recipient.userId);
      const txDocRef = doc(db, 'transactions', txId);
      const notifDocRef = doc(db, 'notifications', notifId);

      let finalSenderWallet: Wallet | null = null;

      // ATOMIC FIRESTORE TRANSACTION
      await runTransaction(db, async (t) => {
        // 1. Read sender wallet
        const senderSnap = await t.get(senderWalletRef);
        let curSenderTotal = senderWallet.totalDemoBalance;
        let curSenderAvailable = senderWallet.availableDemoBalance;
        let curSenderLocked = senderWallet.lockedDemoBalance;

        if (senderSnap.exists()) {
          const sData = senderSnap.data() as Wallet;
          curSenderTotal = typeof sData.totalDemoBalance === 'number' ? sData.totalDemoBalance : curSenderTotal;
          curSenderAvailable = typeof sData.availableDemoBalance === 'number' ? sData.availableDemoBalance : curSenderAvailable;
          curSenderLocked = typeof sData.lockedDemoBalance === 'number' ? sData.lockedDemoBalance : curSenderLocked;
        }

        // 2. Validate sender balance
        if (curSenderAvailable < amount) {
          throw new Error(`الرصيد المتاح غير كافٍ. رصيدك المتاح حالياً هو $${curSenderAvailable.toFixed(2)}.`);
        }

        // 3. Read recipient wallet
        const recipientSnap = await t.get(recipientWalletRef);
        let curRecipientTotal = 0;
        let curRecipientAvailable = 0;
        let curRecipientLocked = 0;
        let recipientNetwork = 'BEP20';

        if (recipientSnap.exists()) {
          const rData = recipientSnap.data() as Wallet;
          curRecipientTotal = typeof rData.totalDemoBalance === 'number' ? rData.totalDemoBalance : 0;
          curRecipientAvailable = typeof rData.availableDemoBalance === 'number' ? rData.availableDemoBalance : 0;
          curRecipientLocked = typeof rData.lockedDemoBalance === 'number' ? rData.lockedDemoBalance : 0;
          recipientNetwork = rData.networkType || 'BEP20';
        }

        // 4. Calculate new balances
        const newSenderTotal = Math.max(0, Math.round((curSenderTotal - amount) * 100) / 100);
        const newSenderAvailable = Math.max(0, Math.round((curSenderAvailable - amount) * 100) / 100);

        const newRecipientTotal = Math.round((curRecipientTotal + amount) * 100) / 100;
        const newRecipientLocked = isLocked 
          ? Math.round((curRecipientLocked + amount) * 100) / 100
          : curRecipientLocked;
        const newRecipientAvailable = isLocked 
          ? curRecipientAvailable 
          : Math.round((curRecipientAvailable + amount) * 100) / 100;

        const updatedSender: Wallet = {
          ...senderWallet,
          walletId: senderWallet.walletId || sender.userId,
          ownerUserId: sender.userId,
          demoAddress: sender.demoAddress,
          totalDemoBalance: newSenderTotal,
          availableDemoBalance: newSenderAvailable,
          lockedDemoBalance: curSenderLocked,
          assets: createDefaultAssets(newSenderTotal),
          updatedAt: nowIso
        };

        const updatedRecipient: Wallet = {
          walletId: recipient.walletId || recipient.userId,
          ownerUserId: recipient.userId,
          networkType: recipientNetwork,
          demoAddress: recipient.demoAddress,
          totalDemoBalance: newRecipientTotal,
          availableDemoBalance: newRecipientAvailable,
          lockedDemoBalance: newRecipientLocked,
          assets: createDefaultAssets(newRecipientTotal),
          updatedAt: nowIso
        };

        // 5. Atomic writes
        t.set(senderWalletRef, cleanForFirestore(updatedSender), { merge: true });
        t.set(recipientWalletRef, cleanForFirestore(updatedRecipient), { merge: true });
        t.set(txDocRef, cleanForFirestore(newTx));
        t.set(notifDocRef, cleanForFirestore(notificationPayload));

        finalSenderWallet = updatedSender;
      });

      return {
        success: true,
        message: isLocked 
          ? `تم إرسال $${amount.toFixed(2)} بنجاح مع تقييد المبلغ لمدة ${lockDurationMinutes} دقيقة.`
          : `تم إرسال $${amount.toFixed(2)} بنجاح إلى ${recipient.displayName || recipient.username}.`,
        transaction: newTx,
        updatedSenderWallet: finalSenderWallet || undefined
      };
    } catch (err: any) {
      console.error('[WalletCloudService] Transfer error:', err);
      return {
        success: false,
        message: err?.message || 'فشلت عملية التحويل. يرجى التحقق من الاتصال بالإنترنت والمحاولة مجدداً.'
      };
    } finally {
      setTimeout(() => {
        activeTransferLocks.delete(opKey);
      }, 2500);
    }
  }

  /**
   * Real-time Cloud Firestore Listener for user's wallet document.
   * Ensures instant balance reflection across devices when money is received or unlocked.
   */
  public static subscribeUserWallet(
    userId: string,
    onData: (wallet: Wallet) => void
  ): Unsubscribe | null {
    if (!userId || typeof window === 'undefined') return null;

    try {
      const walletRef = doc(db, 'wallets', userId);
      return onSnapshot(walletRef, (snap) => {
        if (snap.exists()) {
          const w = snap.data() as Wallet;
          onData(w);
        }
      }, (err) => {
        console.warn('[WalletCloudService] Wallet snapshot warning:', err);
      });
    } catch {
      return null;
    }
  }

  /**
   * Real-time Cloud Firestore Listener for user transactions.
   * Discovers incoming transfers made by other devices/users and reconciles balance.
   */
  public static subscribeUserTransactions(
    userId: string,
    onData: (txs: Transaction[]) => void
  ): Unsubscribe | null {
    if (!userId || typeof window === 'undefined') return null;

    try {
      const txsCol = collection(db, 'transactions');
      return onSnapshot(txsCol, (snap) => {
        const userTxs: Transaction[] = [];
        snap.forEach(d => {
          const t = d.data() as Transaction;
          if (t.senderUserId === userId || t.receiverUserId === userId) {
            userTxs.push(t);
          }
        });
        userTxs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        onData(userTxs);
      }, (err) => {
        handleFirestoreError(err, OperationType.LIST, 'transactions');
      });
    } catch {
      return null;
    }
  }

  /**
   * Real-time Cloud Firestore Listener for user notifications.
   */
  public static subscribeUserNotifications(
    userId: string,
    onData: (notifs: AppNotification[]) => void
  ): Unsubscribe | null {
    if (!userId || typeof window === 'undefined') return null;

    try {
      const notifsCol = collection(db, 'notifications');
      return onSnapshot(notifsCol, (snap) => {
        const userNotifs: AppNotification[] = [];
        snap.forEach(d => {
          const n = d.data() as AppNotification;
          if (n.recipientUserId === userId) {
            userNotifs.push(n);
          }
        });
        userNotifs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        onData(userNotifs);
      }, (err) => {
        handleFirestoreError(err, OperationType.LIST, 'notifications');
      });
    } catch {
      return null;
    }
  }
}
