import { NextRequest, NextResponse } from 'next/server'

export function middleware(request: NextRequest) {
  if (
    request.nextUrl.hostname === 'wheelrank.vercel.app' &&
    request.nextUrl.pathname === '/'
  ) {
    return NextResponse.rewrite(new URL('/wheelrank', request.url))
  }
  return NextResponse.next()
}

export const config = {
  matcher: ['/'],
}
