import { expect } from "vitest";

/**
 * Just enough of the GitHub contents and commits API for one file, in a repository the token can see unless repoHidden.
 * commits holds the messages of the commits that touched the file, oldest first.
 */
export function fakeGithub(opts: { failReads?: number; repoHidden?: boolean } = {}) {
  const state = { content: null as Buffer | null, sha: null as string | null, puts: 0, failReads: opts.failReads ?? 0, commits: [] as string[] };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe("Bearer gh-token");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (url === "https://api.github.com/repos/me/moncsy-data/commits?path=moncsy.db.enc&per_page=100") {
      // GitHub answers 409 for a repository with no commits.
      if (!state.commits.length) return new Response("Git Repository is empty.", { status: 409 });
      return Response.json(state.commits.map((message) => ({ commit: { message } })).reverse());
    }
    if (url === "https://api.github.com/repos/me/moncsy-data") {
      // GitHub answers 404, not 403, for a private repository the token has no access to.
      return opts.repoHidden ? new Response("Not Found", { status: 404 }) : Response.json({ full_name: "me/moncsy-data", private: true });
    }
    expect(url).toBe("https://api.github.com/repos/me/moncsy-data/contents/moncsy.db.enc");
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { content: string; sha?: string; message: string };
      if (state.sha && body.sha !== state.sha) return new Response("sha mismatch", { status: 409 });
      state.content = Buffer.from(body.content, "base64");
      state.sha = `sha${++state.puts}`;
      state.commits.push(body.message);
      return Response.json({ content: { sha: state.sha } }, { status: 201 });
    }
    if (state.failReads > 0) {
      state.failReads--;
      return new Response("boom", { status: 502 });
    }
    if (!state.content) return new Response("Not Found", { status: 404 });
    if (headers.accept === "application/vnd.github.raw+json") return new Response(new Uint8Array(state.content));
    return Response.json({ sha: state.sha });
  }) as typeof fetch;
  return { state, fetchImpl };
}
