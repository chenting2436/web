'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';
import { ArrowUpRight, Check, Copy, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';

const mentor = {
  name: '李江峰',
  role: '研究团队导师',
  email: 'jiangfeng.Li@cumt.endu.cn',
  profile: 'https://faculty.cumt.edu.cn/lijiangfeng/',
};

const students = [
  { name: '张晨', focus: '微震信号处理', email: 'zhang.chen@student.cumt.edu.cn', initials: '张晨', tone: 'blue' },
  { name: '刘宇', focus: '灾害遥感分析', email: 'liu.yu@student.cumt.edu.cn', initials: '刘宇', tone: 'cyan' },
  { name: '王宁', focus: '多源数据融合', email: 'wang.ning@student.cumt.edu.cn', initials: '王宁', tone: 'violet' },
  { name: '赵可', focus: '科研软件工程', email: 'zhao.ke@student.cumt.edu.cn', initials: '赵可', tone: 'rose' },
  { name: '陈曦', focus: '矿山风险识别', email: 'chen.xi@student.cumt.edu.cn', initials: '陈曦', tone: 'cyan' },
  { name: '周林', focus: '地球物理成像', email: 'zhou.lin@student.cumt.edu.cn', initials: '周林', tone: 'blue' },
  { name: '孙悦', focus: '知识系统与检索', email: 'sun.yue@student.cumt.edu.cn', initials: '孙悦', tone: 'rose' },
  { name: '吴桐', focus: '研究流程自动化', email: 'wu.tong@student.cumt.edu.cn', initials: '吴桐', tone: 'violet' },
];

export function TeamDirectory() {
  const [copied, setCopied] = useState('');

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(''), 2400);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copyEmail(email: string) {
    try {
      await navigator.clipboard.writeText(email);
      setCopied(email);
    } catch {
      setCopied('复制失败');
    }
  }

  return (
    <section className="team-directory" aria-label="团队成员">
      <article className="mentor-profile-card">
        <Image
          src="/assets/images/mentor-li-jiangfeng.png"
          alt="李江峰老师"
          width={720}
          height={760}
          priority
        />
        <div className="mentor-profile-content">
          <div>
            <h1>{mentor.name}</h1>
            <p>{mentor.role}</p>
          </div>
          <div className="mentor-actions">
            <Button variant="outline" type="button" onClick={() => void copyEmail(mentor.email)}>
              {copied === mentor.email ? <Check /> : <Mail />}联系我
            </Button>
            <a className="mentor-detail-link" href={mentor.profile} target="_blank" rel="noreferrer">
              了解详情 <ArrowUpRight size={16} />
            </a>
          </div>
        </div>
      </article>

      <div className="student-directory">
        <header>
          <h2>团队成员</h2>
          <span>{students.length} 位成员</span>
        </header>
        <div className="student-card-grid">
          {students.map((student) => (
            <article className="student-card" key={student.email}>
              <span className="student-avatar" data-tone={student.tone}>{student.initials}</span>
              <div>
                <h3>{student.name}</h3>
                <p>{student.focus}</p>
              </div>
              <button type="button" onClick={() => void copyEmail(student.email)}>
                {copied === student.email ? <Check /> : <Copy />}
                {copied === student.email ? '已复制' : '联系我'}
              </button>
            </article>
          ))}
        </div>
      </div>

      {copied && copied !== '复制失败' && (
        <output className="team-copy-toast"><Check />已复制邮箱账号：{copied}</output>
      )}
      {copied === '复制失败' && <div className="team-copy-toast error" role="alert">复制失败，请重试</div>}
    </section>
  );
}
