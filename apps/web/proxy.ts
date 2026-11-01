import { NextResponse, type NextRequest } from "next/server";
import { archiveOriginFor, buildCsp } from "@/lib/csp";

// Sets the Content-Security-Policy on every page. It is built per request because the archive listener's address is a
// deployment setting (NCB_ARCHIVE_PUBLIC_URL, or this host plus NCB_ARCHIVE_PORT) that the build cannot know.
export function proxy(req: NextRequest) {
  const proto = req.headers.get("x-forwarded-proto") === "https" ? "https:" : req.nextUrl.protocol;
  const origin = archiveOriginFor(req.headers.get("host"), proto);
  const res = NextResponse.next();
  res.headers.set("Content-Security-Policy", buildCsp(origin, process.env.NODE_ENV === "production"));
  return res;
}

export const config = {
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico).*)"],
};
