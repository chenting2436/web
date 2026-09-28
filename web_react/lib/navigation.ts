export type NavItem = {
  label: string;
  labelEn: string;
  href: string;
};

export const navItems: NavItem[] = [
  { label: '首页', labelEn: 'Home', href: '/' },
  { label: '科研成果', labelEn: 'Research', href: '/research' },
  { label: '工程与产业化', labelEn: 'Engineering', href: '/engineering' },
  { label: '教学', labelEn: 'Teaching', href: '/teaching' },
  { label: '团队主页', labelEn: 'Team', href: '/team' },
  { label: '个人中心', labelEn: 'Profile', href: '/profile' },
];
