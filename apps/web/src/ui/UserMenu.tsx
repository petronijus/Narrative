/**
 * ui/UserMenu.tsx
 *
 * The signed-in user's menu in the dashboard headers (FoldersHome,
 * FolderDecks): who is signed in, account settings (Access tokens), the
 * admin screen (admins only) and sign-out. Renders nothing while signed out.
 */

import { useNavigate } from 'react-router-dom'
import { ChevronDown, KeyRound, LogOut, ShieldCheck } from 'lucide-react'
import { useAuth } from '../state/AuthContext.js'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export const ACCESS_TOKENS_PATH = '/settings/access-tokens'
export const ADMIN_PATH = '/admin'

export function UserMenu() {
  const navigate = useNavigate()
  const { user, logout } = useAuth()
  if (user === null) return null

  const displayName = user.name ?? user.email ?? user.sub.slice(0, 8)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5" aria-label="Account menu">
          <span className="hidden max-w-[200px] truncate text-sm text-muted-foreground sm:block">
            {displayName}
          </span>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4} className="min-w-[12rem]">
        <DropdownMenuLabel className="font-normal">
          <div className="truncate text-sm font-medium text-foreground">{displayName}</div>
          {user.email && user.email !== displayName && (
            <div className="truncate text-xs text-muted-foreground">{user.email}</div>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          action="account.accessTokens"
          onSelect={() => void navigate(ACCESS_TOKENS_PATH)}
        >
          <KeyRound className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
          Access tokens
        </DropdownMenuItem>
        {user.isAdmin === true && (
          <DropdownMenuItem action="account.admin" onSelect={() => void navigate(ADMIN_PATH)}>
            <ShieldCheck className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
            Administration
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem action="account.signOut" onSelect={() => void logout()}>
          <LogOut className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
