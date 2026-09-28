'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, LockKeyhole, LogOut, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { authApi } from '@/services/api/auth';
import type { User } from '@/types/api';

const roleLabels: Record<string, string> = {
  admin: '管理员',
  researcher: '研究人员',
  teacher: '教师',
  reviewer: '审核人员',
  student: '学生',
  viewer: '只读成员',
};

export function ProfileIdentity() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    let active = true;
    authApi.currentUser()
      .then((currentUser) => {
        if (active) setUser(currentUser);
      })
      .catch(() => {
        if (active) setUser(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function logout() {
    setLoggingOut(true);
    try {
      await authApi.logout();
      router.replace('/login');
      router.refresh();
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <section className="profile-banner" data-authenticated={loading ? 'loading' : user ? 'true' : 'false'} aria-live="polite">
      <div className="profile-avatar">{user ? <UserRound size={30} /> : <LockKeyhole size={28} />}</div>
      <div>
        <h1>{loading ? '正在确认身份…' : user?.displayName ?? '请先登录'}</h1>
        {user && <p>{roleLabels[user.role] ?? user.role}</p>}
      </div>
      {user ? (
        <Button className="action-link" type="button" onClick={logout} disabled={loggingOut}>
          {loggingOut ? '正在退出…' : '退出登录'} <LogOut size={17} />
        </Button>
      ) : (
        <Link className="action-link primary" href="/login">
          登录 <ArrowRight size={17} />
        </Link>
      )}
    </section>
  );
}
