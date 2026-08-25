import type { InputHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export function Checkbox({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input type="checkbox" className={cn('shadcn-checkbox', className)} {...props} />;
}
