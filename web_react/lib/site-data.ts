import {
  GraduationCap,
  FlaskConical,
  Network,
  type LucideIcon,
} from 'lucide-react';

export type HomeEntrance = {
  title: string;
  description: string;
  href: string;
  icon: LucideIcon;
};

export const homeEntrances: HomeEntrance[] = [
  {
    title: '科研工作台',
    description: '论文、遥感、地震与知识工具。',
    href: '/research',
    icon: FlaskConical,
  },
  {
    title: '工程工具',
    description: '监测、数据与安全分析工具。',
    href: '/engineering',
    icon: Network,
  },
  {
    title: '教学工具',
    description: '编程、练习与项目课程工具。',
    href: '/teaching',
    icon: GraduationCap,
  },
];
