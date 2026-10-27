import type { McpServer } from "koishi-plugin-yesimbot-mcp-client/transports";

export interface Config {
  selfId: string;
  mcp: McpServer;
  dailyPostLimit: number;
  dailyInteractionLimit: number;
  pollIntervalMinutes: number;
  feedLimit: number;
  maxWatchedPosts: number;
  communities: string[];
  browseCommunities: string[];
  browseTopics: string[];
}

export interface PostSummary {
  id: string;
  authorId: string;
  title: string;
  text: string;
  source?: string;
}

export interface Comment {
  id: string;
  authorId: string;
  text: string;
  rootId: string;
  replyToId?: string;
}

export interface PostDetail extends PostSummary {
  comments: Comment[];
  commentsComplete?: boolean;
}

export interface Receipt {
  accepted: boolean;
  verified: boolean;
  id?: string;
}

export interface XiaoheiheApi {
  login(): Promise<{ userId: string; username?: string }>;
  feed(limit: number): Promise<PostSummary[]>;
  profile(limit: number): Promise<{ userId: string; posts: PostSummary[] }>;
  search(keyword: string, limit: number): Promise<PostSummary[]>;
  post(id: string): Promise<PostDetail>;
  publish(title: string, content: string, communities: string[]): Promise<Receipt>;
  comment(postId: string, content: string, targetText?: string): Promise<Receipt>;
  close(): Promise<void>;
}
