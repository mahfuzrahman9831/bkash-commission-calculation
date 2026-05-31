/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, Component } from 'react';
import { Plus, Trash2, Calendar, CreditCard, User, Calculator, History, Trash, LogIn, LogOut, AlertCircle, Settings2, Sun, Moon } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { auth, db } from './firebase';
import { 
  signInWithPopup, 
  signInWithRedirect,
  GoogleAuthProvider, 
  onAuthStateChanged, 
  signOut,
  User as FirebaseUser 
} from 'firebase/auth';
import { 
  collection, 
  addDoc, 
  updateDoc,
  query, 
  where, 
  onSnapshot, 
  deleteDoc, 
  doc, 
  serverTimestamp, 
  Timestamp,
  orderBy
} from 'firebase/firestore';

// Utility for tailwind classes
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Error Handling Spec for Firestore Operations
enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

interface Transaction {
  id: string;
  date: string;
  amount: number;
  service: 'bKash' | 'Nagad';
  type: 'Personal' | 'Agent';
  commissionRate: number; // Rate per 1000
  note?: string;
  uid: string;
  partnerId: string;
  createdAt: any;
  commissionType?: 'give' | 'receive';
}

interface Partner {
  id: string;
  name: string;
  uid: string;
  createdAt: any;
  rates?: {
    bKashPersonal?: number;
    bKashAgent?: number;
    NagadPersonal?: number;
    NagadAgent?: number;
  };
}

interface Payment {
  id: string;
  date: string;
  amount: number;
  note?: string;
  uid: string;
  partnerId: string;
  createdAt: any;
}

const ConfirmationModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  darkMode?: boolean;
}> = ({ isOpen, onClose, onConfirm, title, message, darkMode }) => {
  if (!isOpen) return null;

  return (
    <div className={cn("fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4 transition-all duration-200 backdrop-blur-[2px]", darkMode ? "dark" : "")}>
      <div className="bg-white dark:bg-neutral-900 rounded-2xl p-6 max-w-sm w-full shadow-2xl border border-neutral-100 dark:border-neutral-800 animate-in fade-in zoom-in-95 duration-200">
        <h3 className="text-lg font-black text-neutral-900 dark:text-neutral-50 mb-2">{title}</h3>
        <p className="text-neutral-600 dark:text-neutral-400 mb-6 text-sm leading-relaxed">{message}</p>
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 text-sm rounded-xl border border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 font-bold hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-all outline-none"
          >
            বাতিল
          </button>
          <button
            onClick={() => {
              onConfirm();
              onClose();
            }}
            className="flex-1 px-4 py-2 text-sm rounded-xl bg-red-600 dark:bg-red-700 text-white font-bold hover:bg-red-700 dark:hover:bg-red-600 transition-all shadow-md shadow-red-500/10 outline-none"
          >
            মুছে ফেলুন
          </button>
        </div>
      </div>
    </div>
  );
};

function MainApp() {
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('theme');
      if (saved) return saved === 'dark';
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    return false;
  });

  useEffect(() => {
    localStorage.setItem('theme', darkMode ? 'dark' : 'light');
  }, [darkMode]);

  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [selectedPartnerId, setSelectedPartnerId] = useState<string>('');
  const [newPartnerName, setNewPartnerName] = useState('');
  const [partnerRates, setPartnerRates] = useState({
    bKashPersonal: '5',
    bKashAgent: '2',
    NagadPersonal: '5',
    NagadAgent: '2',
  });
  const [isAddingPartner, setIsAddingPartner] = useState(false);
  const [editingPartnerId, setEditingPartnerId] = useState<string | null>(null);
  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
  }>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
  });
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [settlements, setSettlements] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<'current' | 'archived'>('current');
  const [activeFormTab, setActiveFormTab] = useState<'transaction' | 'payment'>('transaction');
  const [expandedSettlementId, setExpandedSettlementId] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    date: format(new Date(), 'yyyy-MM-dd'),
    amount: '',
    service: 'bKash' as const,
    type: 'Personal' as const,
    commissionRate: '5',
    note: '',
    commissionType: 'give' as 'give' | 'receive',
  });
  const [paymentType, setPaymentType] = useState<'received' | 'sent_commission_receive'>('received');
  const [sentRecvFormData, setSentRecvFormData] = useState({
    date: format(new Date(), 'yyyy-MM-dd'),
    amount: '',
    service: 'bKash' as const,
    type: 'Personal' as const,
    commissionRate: '5',
    note: '',
  });
  const [paymentFormData, setPaymentFormData] = useState({
    date: format(new Date(), 'yyyy-MM-dd'),
    amount: '',
    note: '',
  });

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) {
      setPartners([]);
      setSelectedPartnerId('');
      return;
    }

    const q = query(
      collection(db, 'partners'),
      where('uid', '==', user.uid)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const pts = snapshot.docs.map(doc => ({
        ...doc.data(),
        id: doc.id,
      })) as Partner[];
      
      const sortedPartners = pts.sort((a, b) => {
        const timeA = a.createdAt?.toMillis ? a.createdAt.toMillis() : (a.createdAt?.seconds ? a.createdAt.seconds * 1000 : 0);
        const timeB = b.createdAt?.toMillis ? b.createdAt.toMillis() : (b.createdAt?.seconds ? b.createdAt.seconds * 1000 : 0);
        return timeA - timeB;
      });

      setPartners(sortedPartners);
      
      // If none is selected, select the first one
      if (sortedPartners.length > 0) {
        setSelectedPartnerId(prev => prev || sortedPartners[0].id);
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'partners');
    });

    return () => unsubscribe();
  }, [user]);

  useEffect(() => {
    if (!user || !selectedPartnerId) {
      setTransactions([]);
      return;
    }

    const q = query(
      collection(db, 'transactions'), 
      where('uid', '==', user.uid),
      where('partnerId', '==', selectedPartnerId)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const txs = snapshot.docs.map(doc => ({
        ...doc.data(),
        id: doc.id,
      })) as Transaction[];

      // Sort client-side: Absolute priority to entry time (createdAt)
      const sortedTxs = txs.sort((a, b) => {
        const timeA = a.createdAt?.toMillis ? a.createdAt.toMillis() : (a.createdAt?.seconds ? a.createdAt.seconds * 1000 : Date.now() + 10000);
        const timeB = b.createdAt?.toMillis ? b.createdAt.toMillis() : (b.createdAt?.seconds ? b.createdAt.seconds * 1000 : Date.now() + 10000);
        
        if (Math.abs(timeA - timeB) > 100) { // Significant difference in entry time
          return timeB - timeA;
        }
        
        // If entry time is almost identical, sort by date descending
        return b.date.localeCompare(a.date);
      });

      setTransactions(sortedTxs);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'transactions');
    });

    return () => unsubscribe();
  }, [user, selectedPartnerId]);

  useEffect(() => {
    if (!user || !selectedPartnerId) {
      setPayments([]);
      return;
    }

    const q = query(
      collection(db, 'payments'), 
      where('uid', '==', user.uid),
      where('partnerId', '==', selectedPartnerId)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const pms = snapshot.docs.map(doc => ({
        ...doc.data(),
        id: doc.id,
      })) as Payment[];

      const sortedPms = pms.sort((a, b) => {
        const timeA = a.createdAt?.toMillis ? a.createdAt.toMillis() : (a.createdAt?.seconds ? a.createdAt.seconds * 1000 : Date.now() + 10000);
        const timeB = b.createdAt?.toMillis ? b.createdAt.toMillis() : (b.createdAt?.seconds ? b.createdAt.seconds * 1000 : Date.now() + 10000);
        
        if (Math.abs(timeA - timeB) > 100) {
          return timeB - timeA;
        }
        return b.date.localeCompare(a.date);
      });

      setPayments(sortedPms);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'payments');
    });

    return () => unsubscribe();
  }, [user, selectedPartnerId]);

  useEffect(() => {
    if (!user || !selectedPartnerId) {
      setSettlements([]);
      return;
    }

    const q = query(
      collection(db, 'settlements'), 
      where('uid', '==', user.uid)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const allSems = snapshot.docs.map(doc => ({
        ...doc.data(),
        id: doc.id,
      })) as any[];

      const sems = allSems.filter(item => item.partnerId === selectedPartnerId);

      const sortedSems = sems.sort((a, b) => {
        const timeA = a.createdAt?.toMillis ? a.createdAt.toMillis() : (a.createdAt?.seconds ? a.createdAt.seconds * 1000 : Date.now() + 10000);
        const timeB = b.createdAt?.toMillis ? b.createdAt.toMillis() : (b.createdAt?.seconds ? b.createdAt.seconds * 1000 : Date.now() + 10000);
        return timeB - timeA;
      });

      setSettlements(sortedSems);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'settlements');
    });

    return () => unsubscribe();
  }, [user, selectedPartnerId]);

  // Handle activeTab resets when switching partners
  useEffect(() => {
    setActiveTab('current');
    setExpandedSettlementId(null);
  }, [selectedPartnerId]);

  // Auto-fill commission rate when partner, service or type changes
  useEffect(() => {
    if (!selectedPartnerId) return;
    const partner = partners.find(p => p.id === selectedPartnerId);
    if (!partner?.rates) return;

    const key = `${formData.service}${formData.type}` as keyof NonNullable<Partner['rates']>;
    const rate = partner.rates[key];
    if (rate !== undefined) {
      setFormData(prev => ({ ...prev, commissionRate: rate.toString() }));
    }
  }, [selectedPartnerId, formData.service, formData.type, partners]);

  // Auto-fill commission rate for sent_commission_receive form
  useEffect(() => {
    if (!selectedPartnerId) return;
    const partner = partners.find(p => p.id === selectedPartnerId);
    if (!partner?.rates) return;

    const key = `${sentRecvFormData.service}${sentRecvFormData.type}` as keyof NonNullable<Partner['rates']>;
    const rate = partner.rates[key];
    if (rate !== undefined) {
      setSentRecvFormData(prev => ({ ...prev, commissionRate: rate.toString() }));
    }
  }, [selectedPartnerId, sentRecvFormData.service, sentRecvFormData.type, partners]);

  const handleLogin = async (useRedirect = false) => {
    const provider = new GoogleAuthProvider();
    setLoginError(null);
    try {
      if (useRedirect) {
        await signInWithRedirect(auth, provider);
      } else {
        await signInWithPopup(auth, provider);
      }
    } catch (error: any) {
      console.error("Login failed", error);
      setLoginError(error.message || "লগইন করতে সমস্যা হয়েছে। আবার চেষ্টা করুন।");
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error("Logout failed", error);
    }
  };

  const handleAddTransaction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !selectedPartnerId || !formData.amount || !formData.commissionRate) return;

    const txData = {
      date: formData.date,
      amount: parseFloat(formData.amount),
      service: formData.service,
      type: formData.type,
      commissionRate: parseFloat(formData.commissionRate),
      note: formData.note.trim() || null,
      uid: user.uid,
      partnerId: selectedPartnerId,
      createdAt: serverTimestamp(),
      commissionType: 'give',
    };

    try {
      await addDoc(collection(db, 'transactions'), txData);
      setFormData({
        ...formData,
        amount: '',
        note: '',
        commissionType: 'give',
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'transactions');
    }
  };

  const handleAddSentCommissionReceive = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !selectedPartnerId || !sentRecvFormData.amount || !sentRecvFormData.commissionRate) return;

    const txData = {
      date: sentRecvFormData.date,
      amount: parseFloat(sentRecvFormData.amount),
      service: sentRecvFormData.service,
      type: sentRecvFormData.type,
      commissionRate: parseFloat(sentRecvFormData.commissionRate),
      note: sentRecvFormData.note.trim() || null,
      uid: user.uid,
      partnerId: selectedPartnerId,
      createdAt: serverTimestamp(),
      commissionType: 'receive',
    };

    try {
      await addDoc(collection(db, 'transactions'), txData);
      setSentRecvFormData({
        ...sentRecvFormData,
        amount: '',
        note: '',
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'transactions');
    }
  };

  const deleteTransaction = async (id: string) => {
    setConfirmModal({
      isOpen: true,
      title: 'লেনদেন মুছুন',
      message: 'আপনি কি এই লেনদেনটি মুছে ফেলতে চান?',
      onConfirm: async () => {
        try {
          await deleteDoc(doc(db, 'transactions', id));
        } catch (error) {
          handleFirestoreError(error, OperationType.DELETE, `transactions/${id}`);
        }
      },
    });
  };

  const handleAddPartner = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !newPartnerName.trim()) return;

    try {
      const partnerData = {
        name: newPartnerName.trim(),
        uid: user.uid,
        createdAt: serverTimestamp(),
        rates: {
          bKashPersonal: parseFloat(partnerRates.bKashPersonal) || 0,
          bKashAgent: parseFloat(partnerRates.bKashAgent) || 0,
          NagadPersonal: parseFloat(partnerRates.NagadPersonal) || 0,
          NagadAgent: parseFloat(partnerRates.NagadAgent) || 0,
        }
      };
      const docRef = await addDoc(collection(db, 'partners'), partnerData);
      setNewPartnerName('');
      setPartnerRates({
        bKashPersonal: '5',
        bKashAgent: '2',
        NagadPersonal: '5',
        NagadAgent: '2',
      });
      setIsAddingPartner(false);
      setSelectedPartnerId(docRef.id);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'partners');
    }
  };

  const deletePartner = async (id: string) => {
    setConfirmModal({
      isOpen: true,
      title: 'পার্টনার মুছুন',
      message: 'আপনি কি এই পার্টনার এবং তার সকল লেনদেন মুছে ফেলতে চান?',
      onConfirm: async () => {
        try {
          // Delete partner
          await deleteDoc(doc(db, 'partners', id));
          
          if (selectedPartnerId === id) {
            setSelectedPartnerId(partners.find(p => p.id !== id)?.id || '');
          }
        } catch (error) {
          handleFirestoreError(error, OperationType.DELETE, `partners/${id}`);
        }
      },
    });
  };

  const handleAddPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !selectedPartnerId || !paymentFormData.amount) return;

    const paymentData = {
      date: paymentFormData.date,
      amount: parseFloat(paymentFormData.amount),
      note: paymentFormData.note.trim() || null,
      uid: user.uid,
      partnerId: selectedPartnerId,
      createdAt: serverTimestamp(),
    };

    try {
      await addDoc(collection(db, 'payments'), paymentData);
      setPaymentFormData({
        ...paymentFormData,
        amount: '',
        note: '',
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'payments');
    }
  };

  const deletePayment = async (id: string) => {
    setConfirmModal({
      isOpen: true,
      title: 'পেমেন্ট মুছুন',
      message: 'আপনি কি এই পেমেন্টটি মুছে ফেলতে চান?',
      onConfirm: async () => {
        try {
          await deleteDoc(doc(db, 'payments', id));
        } catch (error) {
          handleFirestoreError(error, OperationType.DELETE, `payments/${id}`);
        }
      },
    });
  };

  const handleArchiveTransactions = async () => {
    if (!user || !selectedPartnerId) return;
    if (transactions.length === 0 && payments.length === 0) return;

    setConfirmModal({
      isOpen: true,
      title: 'হিসাব ক্লোজ ও রিসেট করতে চান?',
      message: 'এই পার্টনারের বর্তমান সমস্ত হিসাব সমন্বয় ও রিসেট করা হবে। আগের সমস্ত তথ্য ডেটাবেজে একটি সমাপ্ত রেকর্ড (Archived Settlement) হিসাবে সংরক্ষিত থাকবে এবং চলতি স্ক্রিন খালি হয়ে যাবে।',
      onConfirm: async () => {
        try {
          const pName = partners.find(p => p.id === selectedPartnerId)?.name || 'অপরিচিত';
          const settlementData = {
            uid: user.uid,
            partnerId: selectedPartnerId,
            partnerName: pName,
            date: format(new Date(), 'yyyy-MM-dd'),
            createdAt: serverTimestamp(),
            totalAmount: totals.totalAmount,
            totalCommission: totals.totalCommissionGiven,
            totalCommissionGiven: totals.totalCommissionGiven,
            totalCommissionReceived: totals.totalCommissionReceived,
            totalReceived: totals.totalReceived,
            balance: totals.balance,
            transactions: transactions.map(t => ({
              date: t.date,
              amount: t.amount,
              service: t.service,
              type: t.type,
              commissionRate: t.commissionRate,
              note: t.note || '',
              commissionType: t.commissionType || 'give'
            })),
            payments: payments.map(p => ({
              date: p.date,
              amount: p.amount,
              note: p.note || ''
            }))
          };

          // Save to settlements
          try {
            await addDoc(collection(db, 'settlements'), settlementData);
          } catch (error) {
            handleFirestoreError(error, OperationType.CREATE, 'settlements');
          }

          // Clear active records in parallel batch
          try {
            const deletePromises = [
              ...transactions.map(t => deleteDoc(doc(db, 'transactions', t.id))),
              ...payments.map(p => deleteDoc(doc(db, 'payments', p.id)))
            ];
            await Promise.all(deletePromises);
          } catch (error) {
            handleFirestoreError(error, OperationType.DELETE, 'transactions/payments');
          }
        } catch (error) {
          // General logical or runtime error
          console.error("Error archiving transactions:", error);
        }
      }
    });
  };

  const deleteSettlement = async (id: string) => {
    setConfirmModal({
      isOpen: true,
      title: 'সংরক্ষিত হিসাব মুছুন',
      message: 'আপনি কি এই সংরক্ষিত হিসাবের আর্কাইভ রেকর্ডটি চিরতরে মুছে ফেলতে চান? এটি আর ফেরত পাওয়া যাবে না।',
      onConfirm: async () => {
        try {
          await deleteDoc(doc(db, 'settlements', id));
        } catch (error) {
          handleFirestoreError(error, OperationType.DELETE, `settlements/${id}`);
        }
      },
    });
  };

  const handleUpdatePartnerRates = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !editingPartnerId) return;

    try {
      const partnerRef = doc(db, 'partners', editingPartnerId);
      await updateDoc(partnerRef, {
        rates: {
          bKashPersonal: parseFloat(partnerRates.bKashPersonal) || 0,
          bKashAgent: parseFloat(partnerRates.bKashAgent) || 0,
          NagadPersonal: parseFloat(partnerRates.NagadPersonal) || 0,
          NagadAgent: parseFloat(partnerRates.NagadAgent) || 0,
        }
      });
      setEditingPartnerId(null);
      setPartnerRates({
        bKashPersonal: '5',
        bKashAgent: '2',
        NagadPersonal: '5',
        NagadAgent: '2',
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `partners/${editingPartnerId}`);
    }
  };

  const startEditingPartnerRates = (partner: Partner) => {
    setPartnerRates({
      bKashPersonal: (partner.rates?.bKashPersonal ?? 5).toString(),
      bKashAgent: (partner.rates?.bKashAgent ?? 2).toString(),
      NagadPersonal: (partner.rates?.NagadPersonal ?? 5).toString(),
      NagadAgent: (partner.rates?.NagadAgent ?? 2).toString(),
    });
    setEditingPartnerId(partner.id);
    setIsAddingPartner(false);
  };

  const groupedHistory = useMemo(() => {
    const groups: Record<string, { transactions: Transaction[], payments: Payment[] }> = {};
    
    transactions.forEach(t => {
      if (!groups[t.date]) groups[t.date] = { transactions: [], payments: [] };
      groups[t.date].transactions.push(t);
    });
    
    payments.forEach(p => {
      if (!groups[p.date]) groups[p.date] = { transactions: [], payments: [] };
      groups[p.date].payments.push(p);
    });
    
    const sortedDates = Object.keys(groups).sort((a, b) => {
      // Find latest entry time for each date to keep newest dates at top
      const getLatestTime = (date: string) => {
        const txTime = groups[date].transactions[0]?.createdAt?.toMillis() || 0;
        const pmTime = groups[date].payments[0]?.createdAt?.toMillis() || 0;
        return Math.max(txTime, pmTime);
      };
      
      const timeA = getLatestTime(a);
      const timeB = getLatestTime(b);
      
      if (Math.abs(timeA - timeB) > 100) return timeB - timeA;
      return b.localeCompare(a);
    });

    const sortedGroups: Record<string, { transactions: Transaction[], payments: Payment[] }> = {};
    sortedDates.forEach(date => {
      sortedGroups[date] = groups[date];
    });
      
    return sortedGroups;
  }, [transactions, payments]);

  const totals = useMemo(() => {
    let totalAmount = 0;
    let totalCommissionGiven = 0;
    let totalCommissionReceived = 0;

    transactions.forEach(t => {
      totalAmount += t.amount;
      const commission = (t.amount / 1000) * t.commissionRate;
      if (t.commissionType === 'receive') {
        totalCommissionReceived += commission;
      } else {
        totalCommissionGiven += commission;
      }
    });

    const totalReceived = payments.reduce((acc, p) => acc + p.amount, 0);

    // Adjusted balance formula: Amount (limit we gave them) - Received - Commission we owe + Commission they owe us
    const balance = totalAmount - totalReceived - totalCommissionGiven + totalCommissionReceived;

    return {
      totalAmount,
      totalCommissionGiven,
      totalCommissionReceived,
      totalReceived,
      balance,
    };
  }, [transactions, payments]);

  if (loading) {
    return (
      <div className={cn("min-h-screen flex items-center justify-center transition-colors duration-250", darkMode ? "bg-neutral-950" : "bg-neutral-50")}>
        <div className="flex flex-col items-center gap-4">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-neutral-300 border-t-pink-600"></div>
          <span className="text-sm text-neutral-400 font-medium">অপেক্ষা করুন...</span>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className={cn("min-h-screen flex items-center justify-center p-4 transition-colors duration-250 font-sans", darkMode ? "dark bg-neutral-950 text-neutral-200" : "bg-neutral-50 text-neutral-900")}>
        <div className="bg-white dark:bg-neutral-900 border border-neutral-150 dark:border-neutral-800 p-8 rounded-2xl shadow-xl max-w-md w-full text-center space-y-6">
          <div className="bg-pink-50 dark:bg-pink-950/30 w-20 h-20 rounded-full flex items-center justify-center mx-auto shadow-inner">
            <Calculator className="w-10 h-10 text-pink-600 dark:text-pink-400" />
          </div>
          <div className="space-y-2">
            <h1 className="text-2xl font-black text-neutral-900 dark:text-neutral-50 tracking-tight">স্বাগতম!</h1>
            <p className="text-sm text-neutral-500 dark:text-neutral-400 leading-relaxed">আপনার লেনদেনের হিসাব অনলাইনে সুরক্ষিত রাখতে লগইন করুন।</p>
          </div>
          
          {loginError && (
            <div className="space-y-3">
              <div className="bg-red-50 dark:bg-red-950/20 text-red-650 dark:text-red-400 p-3.5 rounded-xl text-sm flex items-start gap-2 border border-red-100 dark:border-red-900/40 text-left">
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span className="leading-normal">{loginError}</span>
              </div>
              <p className="text-[11px] text-neutral-400 dark:text-neutral-500">
                ফোন থেকে সমস্যা হলে এই লিঙ্কটি সরাসরি ব্রাউজারে ওপেন করুন: <br/>
                <a href="https://ais-pre-75hjggq6ffqklkeie5is5q-538284716822.asia-southeast1.run.app" target="_blank" rel="noopener noreferrer" className="text-pink-600 dark:text-pink-400 hover:underline font-bold">Shared App Link</a>
              </p>
            </div>
          )}

          <div className="space-y-3 pt-2">
            <button 
              onClick={() => handleLogin(false)}
              className="w-full bg-white dark:bg-neutral-850 border border-neutral-200 dark:border-neutral-750 text-neutral-700 dark:text-neutral-200 py-3 rounded-xl font-bold flex items-center justify-center gap-3 hover:bg-neutral-50 dark:hover:bg-neutral-800 hover:border-neutral-300 dark:hover:border-neutral-700 transition-all shadow-sm outline-none text-sm"
            >
              <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" className="w-5 h-5 animate-pulse" alt="Google" />
              গুগল দিয়ে লগইন করুন (পপআপ)
            </button>

            <button 
              onClick={() => handleLogin(true)}
              className="w-full bg-gradient-to-r from-pink-600 to-pink-500 hover:from-pink-700 hover:to-pink-650 text-white py-3 rounded-xl font-bold flex items-center justify-center gap-3 transition-all shadow-md shadow-pink-500/10 hover:shadow-lg outline-none text-sm"
            >
              <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" className="w-5 h-5 brightness-200 invert" alt="Google" />
              মোবাইল দিয়ে লগইন করুন (সরাসরি)
            </button>
          </div>

          <div className="pt-4 border-t border-neutral-100 dark:border-neutral-800 flex justify-center">
            <button
              onClick={() => setDarkMode(!darkMode)}
              className="p-2.5 rounded-xl border border-neutral-250 dark:border-neutral-750 bg-white dark:bg-neutral-850 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 hover:border-neutral-300 dark:hover:border-neutral-700 transition-all duration-200 shadow-sm flex items-center gap-2 text-xs font-bold"
            >
              {darkMode ? (
                <>
                  <Sun className="w-4 h-4 text-amber-500" />
                  <span>লাইট মোড ব্যবহার করুন</span>
                </>
              ) : (
                <>
                  <Moon className="w-4 h-4 text-violet-600" />
                  <span>ডার্ক মোড ব্যবহার করুন</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("min-h-screen bg-neutral-50 dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 transition-colors duration-250 font-sans p-4 md:p-8", darkMode ? "dark" : "")}>
      <div className="max-w-4xl mx-auto space-y-8">
        {/* Header */}
        <header className="flex flex-col md:flex-row items-center justify-between gap-4 pb-2 border-b border-transparent dark:border-neutral-900">
          <div className="flex items-center gap-3">
            <div className="bg-gradient-to-tr from-pink-600 to-pink-500 p-2.5 rounded-xl shadow-lg shadow-pink-500/20">
              <Calculator className="w-6 h-6 text-white" />
            </div>
            <div className="text-left">
              <h1 className="text-xl font-black text-neutral-900 dark:text-neutral-50 tracking-tight">বিকাশ ও নগদ কমিশন ক্যালকুলেটর</h1>
              <p className="text-xs text-neutral-400 dark:text-neutral-500 font-mono tracking-tight">{user.email}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* Theme Toggle Switcher */}
            <button
              onClick={() => setDarkMode(!darkMode)}
              className="p-2.5 rounded-xl border border-neutral-200 dark:border-neutral-805 bg-white dark:bg-neutral-900 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-850 hover:border-neutral-300 dark:hover:border-neutral-700 transition-all duration-200 shadow-sm flex items-center justify-center outline-none"
              title={darkMode ? "লাইট মোড" : "ডার্ক মোড"}
            >
              {darkMode ? <Sun className="w-4 h-4 text-amber-500" /> : <Moon className="w-4 h-4 text-violet-600" />}
            </button>

            <button 
              onClick={handleLogout}
              className="flex items-center gap-2 text-xs font-extrabold text-neutral-500 dark:text-neutral-400 hover:text-red-500 dark:hover:text-red-400 transition-all bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-805 py-2.5 px-4 rounded-xl shadow-sm hover:bg-neutral-50 dark:hover:bg-neutral-850 hover:border-neutral-350 dark:hover:border-neutral-700"
            >
              <LogOut className="w-3.5 h-3.5" /> লগআউট
            </button>
          </div>
        </header>

        <ConfirmationModal
          isOpen={confirmModal.isOpen}
          onClose={() => setConfirmModal({ ...confirmModal, isOpen: false })}
          onConfirm={confirmModal.onConfirm}
          title={confirmModal.title}
          message={confirmModal.message}
          darkMode={darkMode}
        />

        {/* Partner Selection */}
        <section className="bg-white dark:bg-neutral-900 rounded-2xl shadow-sm border border-neutral-200 dark:border-neutral-805 p-6 space-y-4">
          <div className="flex items-center justify-between border-b border-neutral-100 dark:border-neutral-800 pb-3">
            <h2 className="text-base font-black flex items-center gap-2 text-neutral-800 dark:text-neutral-50 tracking-tight">
              <User className="w-4 h-4 text-pink-600 dark:text-pink-500" /> পার্টনার নির্বাচন করুন
            </h2>
            <button 
              onClick={() => setIsAddingPartner(!isAddingPartner)}
              className="text-xs font-bold text-pink-600 dark:text-pink-450 hover:text-pink-700 dark:hover:text-pink-350 flex items-center gap-1 bg-pink-50 dark:bg-pink-950/20 py-1.5 px-3 rounded-lg transition-colors"
            >
              <Plus className="w-3.5 h-3.5" /> নতুন পার্টনার
            </button>
          </div>

          {isAddingPartner && (
            <form onSubmit={handleAddPartner} className="bg-neutral-50 dark:bg-neutral-950/50 p-4 rounded-xl space-y-4 border border-neutral-150 dark:border-neutral-800 animate-in fade-in slide-in-from-top-2">
              <div className="space-y-1">
                <label className="text-xs font-bold text-neutral-500 dark:text-neutral-400">পার্টনারের নাম</label>
                <input
                  type="text"
                  required
                  placeholder="যেমন: রহিম স্টোর"
                  value={newPartnerName}
                  onChange={e => setNewPartnerName(e.target.value)}
                  className="w-full px-4 py-2 text-sm rounded-lg border border-neutral-200 dark:border-neutral-750 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-pink-500/20 focus:border-pink-500 dark:focus:border-pink-500 outline-none transition-all"
                />
              </div>
              
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">বিকাশ পার্সোনাল</label>
                  <input
                    type="number"
                    step="0.1"
                    value={partnerRates.bKashPersonal}
                    onChange={e => setPartnerRates({...partnerRates, bKashPersonal: e.target.value})}
                    className="w-full px-3 py-1.5 text-sm rounded-lg border border-neutral-200 dark:border-neutral-750 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-pink-500/20 outline-none transition-all"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">বিকাশ এজেন্ট</label>
                  <input
                    type="number"
                    step="0.1"
                    value={partnerRates.bKashAgent}
                    onChange={e => setPartnerRates({...partnerRates, bKashAgent: e.target.value})}
                    className="w-full px-3 py-1.5 text-sm rounded-lg border border-neutral-200 dark:border-neutral-750 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-pink-500/20 outline-none transition-all"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">নগদ পার্সোনাল</label>
                  <input
                    type="number"
                    step="0.1"
                    value={partnerRates.NagadPersonal}
                    onChange={e => setPartnerRates({...partnerRates, NagadPersonal: e.target.value})}
                    className="w-full px-3 py-1.5 text-sm rounded-lg border border-neutral-200 dark:border-neutral-750 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-pink-500/20 outline-none transition-all"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">নগদ এজেন্ট</label>
                  <input
                    type="number"
                    step="0.1"
                    value={partnerRates.NagadAgent}
                    onChange={e => setPartnerRates({...partnerRates, NagadAgent: e.target.value})}
                    className="w-full px-3 py-1.5 text-sm rounded-lg border border-neutral-200 dark:border-neutral-750 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-pink-500/20 outline-none transition-all"
                  />
                </div>
              </div>

              <div className="flex gap-2 justify-end pt-2">
                <button
                  type="button"
                  onClick={() => setIsAddingPartner(false)}
                  className="px-4 py-2 rounded-lg text-xs font-bold text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
                >
                  বাতিল
                </button>
                <button
                  type="submit"
                  className="bg-pink-600 dark:bg-pink-700 text-white px-5 py-2 rounded-lg text-xs font-bold hover:bg-pink-700 dark:hover:bg-pink-600 transition-colors shadow-sm"
                >
                  যোগ করুন
                </button>
              </div>
            </form>
          )}

          {editingPartnerId && (
            <form onSubmit={handleUpdatePartnerRates} className="bg-neutral-50 dark:bg-neutral-950/40 p-4 rounded-xl space-y-4 border border-pink-200 dark:border-pink-900/40 animate-in fade-in slide-in-from-top-2">
              <div className="flex items-center justify-between border-b border-neutral-100 dark:border-neutral-800 pb-2">
                <h3 className="text-xs font-bold text-neutral-700 dark:text-neutral-300">কমিশন রেট আপডেট করুন: <span className="text-pink-600 dark:text-pink-400 font-extrabold">{partners.find(p => p.id === editingPartnerId)?.name}</span></h3>
              </div>
              
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 animate-in fade-in duration-200">
                <div className="space-y-1">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">বিকাশ পার্সোনাল</label>
                  <input
                    type="number"
                    step="0.1"
                    value={partnerRates.bKashPersonal}
                    onChange={e => setPartnerRates({...partnerRates, bKashPersonal: e.target.value})}
                    className="w-full px-3 py-1.5 text-sm rounded-lg border border-neutral-200 dark:border-neutral-750 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-pink-500/20 outline-none transition-all"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">বিকাশ এজেন্ট</label>
                  <input
                    type="number"
                    step="0.1"
                    value={partnerRates.bKashAgent}
                    onChange={e => setPartnerRates({...partnerRates, bKashAgent: e.target.value})}
                    className="w-full px-3 py-1.5 text-sm rounded-lg border border-neutral-200 dark:border-neutral-750 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-pink-500/20 outline-none transition-all"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">নগদ পার্সোনাল</label>
                  <input
                    type="number"
                    step="0.1"
                    value={partnerRates.NagadPersonal}
                    onChange={e => setPartnerRates({...partnerRates, NagadPersonal: e.target.value})}
                    className="w-full px-3 py-1.5 text-sm rounded-lg border border-neutral-200 dark:border-neutral-750 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-pink-500/20 outline-none transition-all"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">নগদ এজেন্ট</label>
                  <input
                    type="number"
                    step="0.1"
                    value={partnerRates.NagadAgent}
                    onChange={e => setPartnerRates({...partnerRates, NagadAgent: e.target.value})}
                    className="w-full px-3 py-1.5 text-sm rounded-lg border border-neutral-200 dark:border-neutral-750 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-pink-500/20 outline-none transition-all"
                  />
                </div>
              </div>

              <div className="flex gap-2 justify-end pt-2">
                <button
                  type="button"
                  onClick={() => setEditingPartnerId(null)}
                  className="px-4 py-2 rounded-lg text-xs font-bold text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
                >
                  বাতিল
                </button>
                <button
                  type="submit"
                  className="bg-blue-600 dark:bg-blue-700 text-white px-5 py-2 rounded-lg text-xs font-bold hover:bg-blue-700 dark:hover:bg-blue-600 transition-colors shadow-sm"
                >
                  আপডেট করুন
                </button>
              </div>
            </form>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            {partners.length === 0 ? (
              <p className="text-xs text-neutral-400 dark:text-neutral-500 italic">কোনো পার্টনার নেই। শুরু করতে নতুন পার্টনার যোগ করুন।</p>
            ) : (
              partners.map(p => (
                <div key={p.id} className="relative group">
                  <button
                    onClick={() => setSelectedPartnerId(p.id)}
                    className={cn(
                      "px-4 py-2 rounded-xl text-xs font-bold transition-all border outline-none cursor-pointer",
                      selectedPartnerId === p.id 
                        ? "bg-pink-600 dark:bg-pink-700 border-pink-600 dark:border-pink-700 text-white shadow-md shadow-pink-600/15" 
                        : "bg-white dark:bg-neutral-850 border-neutral-200 dark:border-neutral-750 text-neutral-600 dark:text-neutral-300 hover:border-pink-300 dark:hover:border-pink-700"
                    )}
                  >
                    {p.name}
                  </button>
                  <div className="absolute -top-2.5 -right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200 z-10">
                    <button 
                      onClick={() => startEditingPartnerRates(p)}
                      className="bg-white dark:bg-neutral-800 text-blue-500 hover:text-blue-600 dark:hover:text-blue-400 rounded-full p-1 shadow-md border border-neutral-100 dark:border-neutral-700 cursor-pointer"
                      title="কমিশন রেট আপডেট করুন"
                    >
                      <Settings2 className="w-3 h-3" />
                    </button>
                    <button 
                      onClick={() => deletePartner(p.id)}
                      className="bg-white dark:bg-neutral-800 text-neutral-400 hover:text-red-500 dark:hover:text-red-400 rounded-full p-1 shadow-md border border-neutral-100 dark:border-neutral-700 cursor-pointer"
                      title="মুছে ফেলুন"
                    >
                      <Trash className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        {/* Input Form */}
        {selectedPartnerId ? (
          <section className="bg-white dark:bg-neutral-900 rounded-2xl shadow-sm border border-neutral-200 dark:border-neutral-805 p-6 animate-in fade-in slide-in-from-bottom-2">
            {/* Form Selector Toggle Button */}
            <div className="flex justify-between items-center mb-6 pb-4 border-b border-neutral-100 dark:border-neutral-800 flex-col md:flex-row gap-4">
              <div className="text-sm font-bold text-neutral-500 dark:text-neutral-400">
                পার্টনার: <span className="text-pink-600 dark:text-pink-400 font-extrabold text-base">{partners.find(p => p.id === selectedPartnerId)?.name}</span>
              </div>
              <div className="flex bg-neutral-100 dark:bg-neutral-950 p-1 rounded-xl w-full md:w-auto relative max-w-xl border border-neutral-200 dark:border-neutral-800">
                <button
                  type="button"
                  onClick={() => setActiveFormTab('transaction')}
                  className={`flex-1 md:flex-initial flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                    activeFormTab === 'transaction'
                      ? 'bg-gradient-to-r from-pink-600 to-pink-500 text-white shadow-md shadow-pink-500/10'
                      : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200 hover:bg-neutral-200/50 dark:hover:bg-neutral-850/50'
                  }`}
                >
                  <Plus className="w-4 h-4" />
                  লেনদেন (কমিশন দেবো)
                </button>
                <button
                  type="button"
                  onClick={() => setActiveFormTab('payment')}
                  className={`flex-1 md:flex-initial flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                    activeFormTab === 'payment'
                      ? 'bg-gradient-to-r from-green-600 to-green-500 text-white shadow-md shadow-green-550/10'
                      : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200 hover:bg-neutral-200/50 dark:hover:bg-neutral-850/50'
                  }`}
                >
                  <Plus className="w-4 h-4" />
                  জমা / পাঠানো (কমিশন পাবো)
                </button>
              </div>
            </div>

            {activeFormTab === 'transaction' ? (
              <form onSubmit={handleAddTransaction} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 animate-in fade-in duration-200">
                <div className="space-y-1">
                  <label className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 flex items-center gap-1">
                    <Calendar className="w-3 h-3" /> তারিখ
                  </label>
                  <input
                    type="date"
                    required
                    value={formData.date}
                    onChange={e => setFormData({ ...formData, date: e.target.value })}
                    className="w-full px-4 py-2 text-sm rounded-lg border border-neutral-200 dark:border-neutral-750 bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-pink-500/20 focus:border-pink-500 dark:focus:border-pink-500 outline-none transition-all"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 flex items-center gap-1">
                    <CreditCard className="w-3 h-3" /> সার্ভিস
                  </label>
                  <select
                    value={formData.service}
                    onChange={e => setFormData({ ...formData, service: e.target.value as any })}
                    className="w-full px-4 py-2 text-sm rounded-lg border border-neutral-200 dark:border-neutral-750 bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-pink-500/20 focus:border-pink-500 dark:focus:border-pink-500 outline-none transition-all"
                  >
                    <option value="bKash">বিকাশ (bKash)</option>
                    <option value="Nagad">নগদ (Nagad)</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 flex items-center gap-1">
                    <User className="w-3 h-3" /> টাইপ
                  </label>
                  <select
                    value={formData.type}
                    onChange={e => setFormData({ ...formData, type: e.target.value as any })}
                    className="w-full px-4 py-2 text-sm rounded-lg border border-neutral-200 dark:border-neutral-750 bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-pink-500/20 focus:border-pink-500 dark:focus:border-pink-500 outline-none transition-all"
                  >
                    <option value="Personal">পার্সোনাল (Personal)</option>
                    <option value="Agent">এজেন্ট (Agent)</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 flex items-center gap-1">
                    টাকার পরিমাণ (Amount)
                  </label>
                  <input
                    type="number"
                    required
                    placeholder="যেমন: ৫০০০"
                    value={formData.amount}
                    onChange={e => setFormData({ ...formData, amount: e.target.value })}
                    className="w-full px-4 py-2 text-sm rounded-lg border border-neutral-200 dark:border-neutral-750 bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-pink-500/20 focus:border-pink-500 dark:focus:border-pink-500 outline-none transition-all"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 flex items-center gap-1">
                    কমিশন (প্রতি হাজারে কত টাকা)
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    required
                    placeholder="যেমন: ৫"
                    value={formData.commissionRate}
                    onChange={e => setFormData({ ...formData, commissionRate: e.target.value })}
                    className="w-full px-4 py-2 text-sm rounded-lg border border-neutral-200 dark:border-neutral-750 bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-pink-500/20 focus:border-pink-500 dark:focus:border-pink-500 outline-none transition-all"
                  />
                </div>

                <div className="space-y-1 lg:col-span-1">
                  {/* Empty placeholder column to balance grid row nicely */}
                </div>

                <div className="space-y-1 lg:col-span-2">
                  <label className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 flex items-center gap-1">
                    নোট (ঐচ্ছিক)
                  </label>
                  <input
                    type="text"
                    placeholder="যেমন: ক্যাশ / জরুরি"
                    value={formData.note}
                    onChange={e => setFormData({ ...formData, note: e.target.value })}
                    className="w-full px-4 py-2 text-sm rounded-lg border border-neutral-200 dark:border-neutral-750 bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-pink-500/20 focus:border-pink-500 dark:focus:border-pink-500 outline-none transition-all"
                  />
                </div>

                <div className="flex items-end lg:col-span-1">
                  <button
                    type="submit"
                    className="w-full bg-gradient-to-r from-pink-600 to-pink-500 hover:from-pink-700 hover:to-pink-650 text-white font-bold text-xs py-2.5 px-4 rounded-xl transition-all flex items-center justify-center gap-2 shadow-md shadow-pink-500/10 cursor-pointer"
                  >
                    <Plus className="w-5 h-5" /> যোগ করুন
                  </button>
                </div>
              </form>
            ) : (
              <div className="space-y-6">
                {/* Inner Toggle Tab */}
                <div className="flex bg-neutral-100 dark:bg-neutral-950 p-1 rounded-xl max-w-md border border-neutral-200 dark:border-neutral-800">
                  <button
                    type="button"
                    onClick={() => setPaymentType('received')}
                    className={cn(
                      "flex-1 py-2 px-4 text-xs font-bold rounded-lg transition-all text-center cursor-pointer",
                      paymentType === 'received'
                        ? "bg-white dark:bg-neutral-805 text-green-700 dark:text-green-400 shadow-sm border border-neutral-200 dark:border-neutral-750"
                        : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300"
                    )}
                  >
                    টাকা জমা পাওয়া (Received Amount)
                  </button>
                  <button
                    type="button"
                    onClick={() => setPaymentType('sent_commission_receive')}
                    className={cn(
                      "flex-1 py-2 px-4 text-xs font-bold rounded-lg transition-all text-center cursor-pointer",
                      paymentType === 'sent_commission_receive'
                        ? "bg-white dark:bg-neutral-805 text-green-700 dark:text-green-400 shadow-sm border border-neutral-200 dark:border-neutral-750"
                        : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300"
                    )}
                  >
                    টাকা পাঠানো (কমিশন পাবো)
                  </button>
                </div>

                {paymentType === 'received' ? (
                  <form onSubmit={handleAddPayment} className="grid grid-cols-1 md:grid-cols-3 gap-4 animate-in fade-in duration-200">
                    <div className="space-y-1">
                      <label className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 flex items-center gap-1">
                        <Calendar className="w-3 h-3" /> তারিখ
                      </label>
                      <input
                        type="date"
                        required
                        value={paymentFormData.date}
                        onChange={e => setPaymentFormData({ ...paymentFormData, date: e.target.value })}
                        className="w-full px-4 py-2 text-sm rounded-lg border border-neutral-200 dark:border-neutral-750 bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-green-500/20 focus:border-green-500 dark:focus:border-green-500 outline-none transition-all"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 flex items-center gap-1">
                        টাকার পরিমাণ
                      </label>
                      <input
                        type="number"
                        required
                        placeholder="যেমন: ৫০০০"
                        value={paymentFormData.amount}
                        onChange={e => setPaymentFormData({ ...paymentFormData, amount: e.target.value })}
                        className="w-full px-4 py-2 text-sm rounded-lg border border-neutral-200 dark:border-neutral-750 bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-green-500/20 focus:border-green-500 dark:focus:border-green-500 outline-none transition-all"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 flex items-center gap-1">
                        নোট (ঐচ্ছিক)
                      </label>
                      <input
                        type="text"
                        placeholder="যেমন: ব্যাংক / বিটুবি"
                        value={paymentFormData.note}
                        onChange={e => setPaymentFormData({ ...paymentFormData, note: e.target.value })}
                        className="w-full px-4 py-2 text-sm rounded-lg border border-neutral-200 dark:border-neutral-750 bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-green-500/20 focus:border-green-500 dark:focus:border-green-500 outline-none transition-all"
                      />
                    </div>
                    <div className="flex items-end md:col-span-3">
                      <button
                        type="submit"
                        className="w-full bg-gradient-to-r from-green-600 to-green-500 text-white py-2.5 px-10 rounded-xl text-xs font-bold hover:from-green-700 hover:to-green-650 transition-colors flex items-center justify-center gap-2 shadow-md shadow-green-650/15 md:w-auto md:ml-auto cursor-pointer"
                      >
                        <Plus className="w-4 h-4" /> জমা যোগ করুন
                      </button>
                    </div>
                  </form>
                ) : (
                  <form onSubmit={handleAddSentCommissionReceive} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 animate-in fade-in duration-200">
                    <div className="space-y-1">
                      <label className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 flex items-center gap-1">
                        <Calendar className="w-3 h-3" /> তারিখ
                      </label>
                      <input
                        type="date"
                        required
                        value={sentRecvFormData.date}
                        onChange={e => setSentRecvFormData({ ...sentRecvFormData, date: e.target.value })}
                        className="w-full px-4 py-2 text-sm rounded-lg border border-neutral-200 dark:border-neutral-750 bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-green-500/20 focus:border-green-500 dark:focus:border-green-500 outline-none transition-all"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 flex items-center gap-1">
                        <CreditCard className="w-3 h-3" /> সার্ভিস
                      </label>
                      <select
                        value={sentRecvFormData.service}
                        onChange={e => setSentRecvFormData({ ...sentRecvFormData, service: e.target.value as any })}
                        className="w-full px-4 py-2 text-sm rounded-lg border border-neutral-200 dark:border-neutral-750 bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-green-500/20 focus:border-green-500 dark:focus:border-green-500 outline-none transition-all"
                      >
                        <option value="bKash">বিকাশ (bKash)</option>
                        <option value="Nagad">নগদ (Nagad)</option>
                      </select>
                    </div>

                    <div className="space-y-1">
                      <label className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 flex items-center gap-1">
                        <User className="w-3 h-3" /> টাইপ
                      </label>
                      <select
                        value={sentRecvFormData.type}
                        onChange={e => setSentRecvFormData({ ...sentRecvFormData, type: e.target.value as any })}
                        className="w-full px-4 py-2 text-sm rounded-lg border border-neutral-200 dark:border-neutral-750 bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-green-500/20 focus:border-green-500 dark:focus:border-green-500 outline-none transition-all"
                      >
                        <option value="Personal">পার্সোনাল (Personal)</option>
                        <option value="Agent">এজেন্ট (Agent)</option>
                      </select>
                    </div>

                    <div className="space-y-1">
                      <label className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 flex items-center gap-1">
                        টাকার পরিমাণ (Amount)
                      </label>
                      <input
                        type="number"
                        required
                        placeholder="যেমন: ৫০০০"
                        value={sentRecvFormData.amount}
                        onChange={e => setSentRecvFormData({ ...sentRecvFormData, amount: e.target.value })}
                        className="w-full px-4 py-2 text-sm rounded-lg border border-neutral-200 dark:border-neutral-750 bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-green-500/20 focus:border-green-500 dark:focus:border-green-500 outline-none transition-all"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 flex items-center gap-1">
                        কমিশন (প্রতি হাজারে কত পাবো)
                      </label>
                      <input
                        type="number"
                        step="0.1"
                        required
                        placeholder="যেমন: ৫"
                        value={sentRecvFormData.commissionRate}
                        onChange={e => setSentRecvFormData({ ...sentRecvFormData, commissionRate: e.target.value })}
                        className="w-full px-4 py-2 text-sm rounded-lg border border-neutral-200 dark:border-neutral-750 bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-green-500/20 focus:border-green-500 dark:focus:border-green-500 outline-none transition-all"
                      />
                    </div>

                    <div className="space-y-1 lg:col-span-1">
                      {/* Empty cell to balance layout */}
                    </div>

                    <div className="space-y-1 lg:col-span-2">
                      <label className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 flex items-center gap-1">
                        নোট (ঐচ্ছিক)
                      </label>
                      <input
                        type="text"
                        placeholder="যেমন: কমিশন সহ পাঠানো"
                        value={sentRecvFormData.note}
                        onChange={e => setSentRecvFormData({ ...sentRecvFormData, note: e.target.value })}
                        className="w-full px-4 py-2 text-sm rounded-lg border border-neutral-200 dark:border-neutral-750 bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-green-500/20 focus:border-green-500 dark:focus:border-green-500 outline-none transition-all"
                      />
                    </div>

                    <div className="flex items-end lg:col-span-1">
                      <button
                        type="submit"
                        className="w-full bg-gradient-to-r from-green-600 to-green-500 hover:from-green-700 hover:to-green-650 text-white font-bold text-xs py-2.5 px-4 rounded-xl transition-all flex items-center justify-center gap-2 shadow-md shadow-green-650/15 cursor-pointer"
                      >
                        <Plus className="w-4 h-4" /> পাঠানো যোগ করুন
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}
          </section>
        ) : (
          <div className="bg-pink-50/40 dark:bg-pink-950/10 p-8 rounded-2xl border border-pink-100/40 dark:border-pink-900/40 text-center space-y-2 animate-pulse">
            <User className="w-12 h-12 text-pink-300 dark:text-pink-700 mx-auto" />
            <p className="text-pink-800 dark:text-pink-400 text-sm font-bold">লেনদেন যোগ করতে প্রথমে একজন পার্টনার নির্বাচন করুন।</p>
          </div>
        )}

        {/* Summary Cards */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-white dark:bg-neutral-900 p-8 rounded-2xl shadow-sm border border-neutral-200 dark:border-neutral-805 flex items-center justify-between overflow-hidden min-h-[140px]">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-1">মোট লেনদেন</p>
              <p className="text-2xl sm:text-3xl md:text-4xl font-bold text-neutral-900 dark:text-neutral-100 break-words leading-tight">
                ৳ {totals.totalAmount.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
              </p>
            </div>
            <div className="bg-blue-50 dark:bg-blue-950/40 p-5 rounded-full flex-shrink-0 ml-6">
              <CreditCard className="w-10 h-10 text-blue-600" />
            </div>
          </div>
          <div className="bg-white dark:bg-neutral-900 p-6 rounded-2xl shadow-sm border border-neutral-200 dark:border-neutral-805 flex flex-col justify-between overflow-hidden min-h-[140px]">
            <div className="flex items-center justify-between gap-2 text-left">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-1">কমিশন হিসাব</p>
                <div className="space-y-0.5 mt-1">
                  <p className="text-xs text-neutral-500 dark:text-neutral-400 flex justify-between gap-1.5">
                    <span>দেওয়া কমিশন:</span>
                    <span className="font-extrabold text-pink-600">৳ {totals.totalCommissionGiven.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                  </p>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400 flex justify-between gap-1.5">
                    <span>পাওনা কমিশন:</span>
                    <span className="font-extrabold text-green-600">৳ {totals.totalCommissionReceived.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                  </p>
                </div>
              </div>
              <div className="bg-pink-50 dark:bg-pink-950/40 p-4 rounded-full flex-shrink-0">
                <Calculator className="w-8 h-8 text-pink-600" />
              </div>
            </div>
            <div className="mt-4 pt-2 border-t border-neutral-100 dark:border-neutral-800 flex justify-between items-center">
              <span className="text-xs font-bold text-neutral-500 dark:text-neutral-400">নিট কমিশন:</span>
              <span className={cn(
                "text-base font-black",
                totals.totalCommissionReceived - totals.totalCommissionGiven >= 0 ? "text-green-600" : "text-pink-600"
              )}>
                ৳ {(totals.totalCommissionReceived - totals.totalCommissionGiven).toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </span>
            </div>
          </div>
          <div className="bg-white dark:bg-neutral-900 p-6 rounded-2xl shadow-sm border border-neutral-200 dark:border-neutral-805 flex items-center justify-between overflow-hidden min-h-[140px]">
            <div className="min-w-0 flex-1 text-left">
              <p className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-1">জমা পাওয়া গেছে</p>
              <p className="text-2xl sm:text-3xl font-bold text-green-600 break-words leading-tight">
                ৳ {totals.totalReceived.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
              </p>
            </div>
            <div className="bg-green-50 dark:bg-green-950/40 p-4 rounded-full flex-shrink-0 ml-4">
              <Plus className="w-8 h-8 text-green-600" />
            </div>
          </div>
          <div className="bg-white dark:bg-neutral-900 p-6 rounded-2xl shadow-sm border border-neutral-200 dark:border-neutral-805 flex flex-col justify-between overflow-hidden min-h-[140px]">
            <div className="flex items-center justify-between gap-2 text-left">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-1">বাকি (Balance)</p>
                <p className={cn(
                  "text-2xl sm:text-3xl font-black break-words leading-tight",
                  totals.balance > 0 ? "text-red-500" : "text-blue-600"
                )}>
                  ৳ {totals.balance.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
                </p>
              </div>
              <div className={cn(
                "p-4 rounded-full flex-shrink-0 ml-4",
                totals.balance > 0 ? "bg-red-50 dark:bg-red-950/40" : "bg-blue-50 dark:bg-blue-950/40"
              )}>
                <History className={cn(
                  "w-8 h-8",
                  totals.balance > 0 ? "text-red-500" : "text-blue-600"
                )} />
              </div>
            </div>
            <div className="mt-4 pt-2 border-t border-neutral-100 dark:border-neutral-800 text-[10px] text-neutral-400 dark:text-neutral-500 font-bold leading-none text-left">
              হিসাব: লেনদেন + পাওনা কমিশন - দেওয়া কমিশন - জমা
            </div>
          </div>
        </section>

        {/* Settle Account Banner */}
        {selectedPartnerId && (transactions.length > 0 || payments.length > 0) && (
          <div className="bg-white dark:bg-neutral-900 p-6 rounded-2xl shadow-sm border border-neutral-200 dark:border-neutral-805 flex flex-col md:flex-row md:items-center md:justify-between gap-4 animate-in fade-in duration-200">
            <div className="space-y-1 text-left">
              <h3 className="font-bold text-neutral-800 dark:text-neutral-200 flex items-center gap-1.5">
                <History className="w-5 h-5 text-pink-600" /> কাস্টমার হিসাব সম্পন্ন ও রিসেট করুন
              </h3>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                এই পার্টনারের চলতি হিসাব সম্পন্ন (Settle) করে সমস্ত কমিশন ও লেনদেনের হিসাব আর্কাইভে সংরক্ষণ করুন। এতে চলতি লেনদেনগুলো সম্পূর্ণ ক্লিয়ার হবে।
              </p>
            </div>
            <button
              onClick={handleArchiveTransactions}
              className="bg-neutral-900 dark:bg-neutral-950 dark:border dark:border-neutral-800 dark:hover:bg-neutral-900 text-white px-5 py-2.5 rounded-xl text-xs font-bold transition-all shadow-sm flex items-center justify-center gap-1.5 self-start md:self-auto cursor-pointer"
            >
              হিসাব সম্পন্ন ও রিসেট (Settle Account)
            </button>
          </div>
        )}

        {/* History Flow */}
        <section className="space-y-6">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <h2 className="text-xl md:text-2xl font-black flex items-center gap-2 text-left text-neutral-850 dark:text-neutral-150">
              <History className="w-6 h-6 text-neutral-700 dark:text-neutral-300" /> বিস্তারিত ইতিহাস (Transactions & Payments)
            </h2>
            {selectedPartnerId && (
              <div className="flex bg-neutral-200 dark:bg-neutral-950 p-1 rounded-xl self-start md:self-auto border dark:border-neutral-800">
                <button
                  onClick={() => setActiveTab('current')}
                  className={cn(
                    "px-4 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer",
                    activeTab === 'current'
                      ? "bg-white dark:bg-neutral-805 text-neutral-900 dark:text-neutral-100 shadow-md"
                      : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200"
                  )}
                >
                  চলতি হিসাব
                </button>
                <button
                  onClick={() => setActiveTab('archived')}
                  className={cn(
                    "px-4 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1 cursor-pointer",
                    activeTab === 'archived'
                      ? "bg-white dark:bg-neutral-805 text-neutral-900 dark:text-neutral-100 shadow-md"
                      : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200"
                  )}
                >
                  আর্কাইভড হিসাবসমূহ ({settlements.length})
                </button>
              </div>
            )}
          </div>

          {activeTab === 'current' ? (
            Object.keys(groupedHistory).length === 0 ? (
              <div className="bg-white dark:bg-neutral-900 p-20 rounded-3xl border border-dashed border-neutral-300 dark:border-neutral-750 text-center space-y-3">
                <History className="w-12 h-12 text-neutral-200 dark:text-neutral-700 mx-auto" />
                <p className="text-neutral-400 dark:text-neutral-500 font-medium my-0">এখনো কোনো চলতি এন্ট্রি পাওয়া যায়নি।</p>
              </div>
            ) : (
              <div className="space-y-10">
                {Object.entries(groupedHistory).map(([date, entry]) => {
                  const { transactions: dayTxs, payments: dayPms } = entry as { transactions: Transaction[], payments: Payment[] };
                  return (
                    <div key={date} className="space-y-4">
                    <div className="sticky top-0 z-10 flex items-center gap-3 py-2 bg-neutral-100/80 dark:bg-neutral-950/80 backdrop-blur-sm">
                      <span className="text-sm font-black text-neutral-600 dark:text-neutral-300 bg-white dark:bg-neutral-900 px-4 py-1 rounded-full shadow-sm border border-neutral-200 dark:border-neutral-800">
                        {format(parseISO(date), 'dd MMMM, yyyy')}
                      </span>
                      <div className="h-px flex-1 bg-neutral-300 dark:bg-neutral-800"></div>
                    </div>

                    <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 items-start">
                      {/* Transactions for this date */}
                      <div className="xl:col-span-2 space-y-2 text-left">
                        <div className="flex items-center gap-2 mb-1 px-1">
                          <CreditCard className="w-4 h-4 text-pink-500" />
                          <h3 className="text-sm font-bold text-neutral-600 dark:text-neutral-400 uppercase tracking-wider">লেনদেনের তালিকা</h3>
                          <span className="text-[10px] bg-pink-100 dark:bg-pink-955/50 text-pink-700 dark:text-pink-400 px-2 rounded-full font-bold">
                            {dayTxs.length} এন্ট্রি
                          </span>
                        </div>
                        <div className="bg-white dark:bg-neutral-900 rounded-2xl shadow-sm border border-neutral-200 dark:border-neutral-805 overflow-hidden">
                          {dayTxs.length === 0 ? (
                            <div className="p-6 text-center text-neutral-400 dark:text-neutral-500 italic text-xs">কোনো লেনদেন নেই।</div>
                          ) : (
                            <div className="overflow-x-auto">
                              <table className="w-full text-left border-collapse min-w-[500px]">
                                <thead>
                                  <tr className="bg-neutral-50 dark:bg-neutral-950 border-b border-neutral-200 dark:border-neutral-800 text-[10px] uppercase font-bold tracking-wider text-neutral-400 dark:text-neutral-500">
                                    <th className="px-4 py-3">সার্ভিস</th>
                                    <th className="px-4 py-3">タイপ</th>
                                    <th className="px-4 py-3">পরিমাণ</th>
                                    <th className="px-4 py-3">কমিশন</th>
                                    <th className="px-4 py-3">নোট</th>
                                    <th className="px-4 py-3 text-right"></th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                                  {dayTxs.map(t => {
                                    const commission = (t.amount / 1000) * t.commissionRate;
                                    return (
                                      <tr key={t.id} className="hover:bg-neutral-50/50 dark:hover:bg-neutral-950/20 transition-colors">
                                        <td className="px-4 py-3">
                                          <span className={cn(
                                            "text-[10px] font-black px-2 py-0.5 rounded uppercase",
                                            t.service === 'bKash' ? "bg-pink-100 dark:bg-pink-955/50 text-pink-700 dark:text-pink-400" : "bg-orange-100 dark:bg-orange-955/50 text-orange-700 dark:text-orange-400"
                                          )}>
                                            {t.service}
                                          </span>
                                        </td>
                                        <td className="px-4 py-3 text-xs text-neutral-600 dark:text-neutral-400">{t.type}</td>
                                        <td className="px-4 py-3 text-sm font-black text-neutral-800 dark:text-neutral-200">৳ {t.amount.toLocaleString()}</td>
                                        <td className="px-4 py-3">
                                          <div className="flex flex-col">
                                            <span className={cn(
                                              "text-sm font-black flex items-center gap-1.5",
                                              t.commissionType === 'receive' ? "text-green-600 dark:text-green-400" : "text-pink-600 dark:text-pink-400"
                                            )}>
                                              ৳ {commission.toLocaleString()}
                                              <span className={cn(
                                                "text-[9px] font-extrabold px-1.5 py-0.5 rounded",
                                                t.commissionType === 'receive' ? "bg-green-100 dark:bg-green-955/40 text-green-750 dark:text-green-400" : "bg-pink-100 dark:bg-pink-955/40 text-pink-700 dark:text-pink-400"
                                              )}>
                                                {t.commissionType === 'receive' ? 'পাবো' : 'দেবো'}
                                              </span>
                                            </span>
                                            <span className="text-[10px] text-neutral-400 dark:text-neutral-550">@{t.commissionRate}</span>
                                          </div>
                                        </td>
                                        <td className="px-4 py-3">
                                          <div className="text-[10px] text-neutral-400 dark:text-neutral-500 max-w-[85px] break-words line-clamp-1" title={t.note}>
                                            {t.note || '-'}
                                          </div>
                                        </td>
                                        <td className="px-4 py-3 text-right">
                                          <button
                                            onClick={() => deleteTransaction(t.id)}
                                            className="p-1.5 text-neutral-400 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/50 rounded-lg transition-all cursor-pointer"
                                          >
                                            <Trash2 className="w-4 h-4" />
                                          </button>
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Payments for this date */}
                      <div className="xl:col-span-1 space-y-2 text-left">
                         <div className="flex items-center gap-2 mb-1 px-1">
                          <Plus className="w-4 h-4 text-green-500" />
                          <h3 className="text-sm font-bold text-neutral-600 dark:text-neutral-400 uppercase tracking-wider">জমার তালিকা</h3>
                          <span className="text-[10px] bg-green-100 dark:bg-green-955/50 text-green-700 dark:text-green-400 px-2 rounded-full font-bold">
                            {dayPms.length} এন্ট্রি
                          </span>
                        </div>
                        <div className="bg-white dark:bg-neutral-900 rounded-2xl shadow-sm border border-neutral-200 dark:border-neutral-805 overflow-hidden">
                          {dayPms.length === 0 ? (
                            <div className="p-6 text-center text-neutral-400 dark:text-neutral-500 italic text-xs">কোনো জমা নেই।</div>
                          ) : (
                            <table className="w-full text-left border-collapse">
                              <thead>
                                <tr className="bg-neutral-50 dark:bg-neutral-950 border-b border-neutral-200 dark:border-neutral-800 text-[10px] uppercase font-bold tracking-wider text-neutral-400 dark:text-neutral-500">
                                  <th className="px-4 py-3">পরিমাণ</th>
                                  <th className="px-4 py-3">নোট</th>
                                  <th className="px-4 py-3 text-right text-right"></th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                                {dayPms.map(p => (
                                  <tr key={p.id} className="hover:bg-neutral-50/50 dark:hover:bg-neutral-950/20 transition-colors">
                                    <td className="px-4 py-3 text-sm font-black text-green-600">
                                      ৳ {p.amount.toLocaleString()}
                                    </td>
                                    <td className="px-4 py-3">
                                      <div className="text-[10px] text-neutral-400 dark:text-neutral-500 max-w-[80px] break-words line-clamp-1" title={p.note}>
                                        {p.note || '-'}
                                      </div>
                                    </td>
                                    <td className="px-4 py-3 text-right">
                                      <button
                                        onClick={() => deletePayment(p.id)}
                                        className="p-1.5 text-neutral-400 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/50 rounded-lg transition-all cursor-pointer"
                                      >
                                        <Trash2 className="w-4 h-4" />
                                      </button>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                  );
                })}
              </div>
            )
          ) : (
            // Settlements listing (Archived history)
            settlements.length === 0 ? (
              <div className="bg-white dark:bg-neutral-900 p-20 rounded-3xl border border-dashed border-neutral-300 dark:border-neutral-750 text-center space-y-3">
                <History className="w-12 h-12 text-neutral-200 dark:text-neutral-700 mx-auto" />
                <p className="text-neutral-400 dark:text-neutral-500 font-medium">কোনো সম্পন্ন বা আর্কাইভড হিসাব পাওয়া যায়নি।</p>
              </div>
            ) : (
              <div className="space-y-4">
                {settlements.map((sem) => {
                  const isExpanded = expandedSettlementId === sem.id;
                  const formattedArchivedDate = sem.createdAt?.toDate 
                    ? format(sem.createdAt.toDate(), 'dd MMMM yyyy, hh:mm a') 
                    : sem.date;

                  return (
                    <div key={sem.id} className="bg-white dark:bg-neutral-900 rounded-2xl shadow-sm border border-neutral-200 dark:border-neutral-805 overflow-hidden transition-all duration-200">
                      {/* Accordion Header */}
                      <div 
                        onClick={() => setExpandedSettlementId(isExpanded ? null : sem.id)}
                        className="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4 cursor-pointer hover:bg-neutral-50/50 dark:hover:bg-neutral-950/20 transition-colors"
                      >
                        <div className="space-y-1 text-left">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-black text-neutral-800 dark:text-neutral-200">
                              সমাপ্ত হিসাব: {sem.partnerName}
                            </span>
                            <span className="bg-neutral-100 dark:bg-neutral-955 text-neutral-800 dark:text-neutral-300 text-[9px] font-bold px-1.5 py-0.5 rounded border dark:border-neutral-800">
                              ARCHIVED
                            </span>
                          </div>
                          <p className="text-xs text-neutral-400 dark:text-neutral-500 flex items-center gap-1">
                            <Calendar className="w-3.5 h-3.5" /> সমাপ্ত করার সময়: {formattedArchivedDate}
                          </p>
                        </div>

                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-left lg:text-right flex-1 lg:max-w-xl">
                          <div>
                            <span className="text-[9px] block font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">মোট লেনদেন</span>
                            <span className="text-sm font-black text-neutral-700 dark:text-neutral-300">৳ {sem.totalAmount.toLocaleString()}</span>
                          </div>
                          <div>
                            <span className="text-[9px] block font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">মোট কমিশন</span>
                            {sem.totalCommissionGiven !== undefined || sem.totalCommissionReceived !== undefined ? (
                              <div className="text-[10px] leading-tight space-y-0.5">
                                <p className="text-pink-600 dark:text-pink-400 font-extrabold flex justify-between lg:justify-end gap-1"><span>দেবো:</span> ৳ {(sem.totalCommissionGiven ?? sem.totalCommission).toLocaleString()}</p>
                                <p className="text-green-600 dark:text-green-400 font-extrabold flex justify-between lg:justify-end gap-1"><span>পাবো:</span> ৳ {(sem.totalCommissionReceived ?? 0).toLocaleString()}</p>
                              </div>
                            ) : (
                              <span className="text-sm font-black text-pink-600 dark:text-pink-400">৳ {sem.totalCommission.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                            )}
                          </div>
                          <div>
                            <span className="text-[9px] block font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">জমা</span>
                            <span className="text-sm font-black text-green-600 dark:text-green-400">৳ {sem.totalReceived.toLocaleString()}</span>
                          </div>
                          <div>
                            <span className="text-[9px] block font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">বাকি (Balance)</span>
                            <span className={cn(
                              "text-sm font-black",
                              sem.balance > 0 ? "text-red-600 dark:text-red-400" : "text-blue-600 dark:text-blue-400"
                            )}>৳ {sem.balance.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 justify-end self-end lg:self-auto">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteSettlement(sem.id);
                            }}
                            className="p-1.5 text-neutral-400 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 rounded-lg transition-all cursor-pointer"
                            title="আর্কাইভ মুছে ফেলুন"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>

                      {/* Accordion Body */}
                      {isExpanded && (
                        <div className="bg-neutral-50 dark:bg-neutral-950 border-t border-neutral-100 dark:border-neutral-850 p-6 space-y-6">
                          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 items-start">
                            {/* Transactions Table */}
                            <div className="xl:col-span-2 space-y-2 text-left">
                              <h4 className="text-xs font-bold text-neutral-500 dark:text-neutral-400 uppercase tracking-wider flex items-center gap-1">
                                <CreditCard className="w-3.5 h-3.5 text-pink-500" /> লেনদেনের তালিকা ({sem.transactions?.length || 0})
                              </h4>
                              <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 overflow-hidden">
                                {!sem.transactions || sem.transactions.length === 0 ? (
                                  <div className="p-4 text-center text-neutral-400 dark:text-neutral-500 italic text-xs">কোনো লেনদেন রেকর্ড করা হয়নি।</div>
                                ) : (
                                  <div className="overflow-x-auto">
                                    <table className="w-full text-left border-collapse min-w-[500px]">
                                      <thead>
                                        <tr className="bg-neutral-50 dark:bg-neutral-950 border-b border-neutral-200 dark:border-neutral-805 text-[9px] font-bold uppercase text-neutral-450 dark:text-neutral-500">
                                          <th className="px-4 py-2.5">তারিখ</th>
                                          <th className="px-4 py-2.5">সার্ভিস</th>
                                          <th className="px-4 py-2.5">টাইপ</th>
                                          <th className="px-4 py-2.5">পরিমাণ</th>
                                          <th className="px-4 py-2.5">কমিশন</th>
                                          <th className="px-4 py-2.5">নোট</th>
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                                        {sem.transactions.map((t: any, index: number) => {
                                          const tCommission = (t.amount / 1000) * t.commissionRate;
                                          return (
                                            <tr key={index} className="text-xs hover:bg-neutral-50/50 dark:hover:bg-neutral-950/20">
                                              <td className="px-4 py-2.5 text-neutral-500 dark:text-neutral-450 whitespace-nowrap">{t.date}</td>
                                              <td className="px-4 py-2.5">
                                                <span className={cn(
                                                  "text-[9px] font-bold px-1.5 py-0.5 rounded uppercase",
                                                  t.service === 'bKash' ? "bg-pink-100 dark:bg-pink-955/50 text-pink-700 dark:text-pink-400" : "bg-orange-100 dark:bg-orange-955/50 text-orange-700 dark:text-orange-400"
                                                )}>
                                                  {t.service}
                                                </span>
                                              </td>
                                              <td className="px-4 py-2.5 text-neutral-600 dark:text-neutral-450">{t.type}</td>
                                              <td className="px-4 py-2.5 font-bold text-neutral-800 dark:text-neutral-200 text-left">৳ {t.amount.toLocaleString()}</td>
                                              <td className="px-4 py-2.5 text-left">
                                                <div className="flex flex-col text-left">
                                                  <span className={cn(
                                                    "font-bold flex items-center gap-1",
                                                    t.commissionType === 'receive' ? "text-green-600 dark:text-green-400" : "text-pink-600 dark:text-pink-400"
                                                  )}>
                                                    ৳ {tCommission.toLocaleString()}
                                                    <span className={cn(
                                                      "text-[8px] font-extrabold px-1 rounded",
                                                      t.commissionType === 'receive' ? "bg-green-100 dark:bg-green-955/40 text-green-750 dark:text-green-400" : "bg-pink-100 dark:bg-pink-955/40 text-pink-700 dark:text-pink-400"
                                                    )}>
                                                      {t.commissionType === 'receive' ? 'পাবো' : 'দেবো'}
                                                    </span>
                                                  </span>
                                                  <span className="text-[9px] text-neutral-455 dark:text-neutral-500">(@{t.commissionRate})</span>
                                                </div>
                                              </td>
                                              <td className="px-4 py-2.5 text-neutral-400 dark:text-neutral-550 truncate max-w-[124px]" title={t.note}>{t.note || '-'}</td>
                                            </tr>
                                          );
                                        })}
                                      </tbody>
                                    </table>
                                  </div>
                                )}
                              </div>
                            </div>

                            {/* Payments Table */}
                            <div className="xl:col-span-1 space-y-2 text-left">
                              <h4 className="text-xs font-bold text-neutral-500 dark:text-neutral-400 uppercase tracking-wider flex items-center gap-1">
                                <Plus className="w-3.5 h-3.5 text-green-500" /> জমার তালিকা ({sem.payments?.length || 0})
                              </h4>
                              <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 overflow-hidden">
                                {!sem.payments || sem.payments.length === 0 ? (
                                  <div className="p-4 text-center text-neutral-400 dark:text-neutral-500 italic text-xs">কোনো জমা রেকর্ড করা হয়নি।</div>
                                ) : (
                                  <table className="w-full text-left border-collapse">
                                    <thead>
                                      <tr className="bg-neutral-50 dark:bg-neutral-950 border-b border-neutral-200 dark:border-neutral-805 text-[9px] font-bold uppercase text-neutral-450 dark:text-neutral-500">
                                        <th className="px-4 py-2.5">তারিখ</th>
                                        <th className="px-4 py-2.5">পরিমাণ</th>
                                        <th className="px-4 py-2.5">নোট</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800 text-xs">
                                      {sem.payments.map((p: any, index: number) => (
                                        <tr key={index} className="hover:bg-neutral-50/50 dark:hover:bg-neutral-950/20">
                                          <td className="px-4 py-2.5 text-neutral-500 dark:text-neutral-450 whitespace-nowrap">{p.date}</td>
                                          <td className="px-4 py-2.5 font-bold text-green-600 dark:text-green-400">৳ {p.amount.toLocaleString()}</td>
                                          <td className="px-4 py-2.5 text-neutral-400 dark:text-neutral-550 truncate max-w-[80px]" title={p.note}>{p.note || '-'}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )
          )}
        </section>
      </div>
    </div>
  );
}

// Error Boundary Component
class ErrorBoundary extends (React.Component as any) {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      let errorMessage = "কিছু একটা ভুল হয়েছে।";
      try {
        const parsed = JSON.parse(this.state.error.message);
        if (parsed.error) errorMessage = `ফায়ারবেস ত্রুটি: ${parsed.error}`;
      } catch (e) {
        errorMessage = this.state.error.message || errorMessage;
      }

      return (
        <div className="min-h-screen flex items-center justify-center bg-neutral-100 p-4">
          <div className="bg-white p-8 rounded-2xl shadow-lg max-w-md w-full text-center space-y-4">
            <AlertCircle className="w-16 h-16 text-red-500 mx-auto" />
            <h2 className="text-2xl font-bold text-neutral-900">ত্রুটি!</h2>
            <p className="text-neutral-600">{errorMessage}</p>
            <button 
              onClick={() => window.location.reload()}
              className="w-full bg-pink-600 text-white py-2 rounded-lg font-bold hover:bg-pink-700 transition-colors"
            >
              আবার চেষ্টা করুন
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <MainApp />
    </ErrorBoundary>
  );
}
