import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

type ButtonVariant = 'default' | 'secondary' | 'outline' | 'destructive' | 'ghost';
type ButtonSize = 'default' | 'sm' | 'icon';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({ className, variant = 'default', size = 'default', ...props }: ButtonProps) {
  return (
    <button
      className={cn('shadcn-button', `shadcn-button-${variant}`, `shadcn-button-${size}`, className)}
      {...props}
    />
  );
}
