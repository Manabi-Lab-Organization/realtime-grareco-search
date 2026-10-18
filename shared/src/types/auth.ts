export type UserRole = 'user' | 'admin';

export interface User {
  id: number;
  email: string;
  displayName: string | null;
  role: UserRole;
  inviteVerified: boolean;
  createdAt: string;
  features?: ServerFeatures;
}

export interface ServerFeatures {
  grareco: boolean;
  autoGrareco: boolean;
  grarecoSearch: boolean;
  research: boolean;
  roomObservation: boolean;
  googleLogin: boolean;
  email: boolean;
}

export const ALL_FEATURES_ON: ServerFeatures = {
  grareco: true,
  autoGrareco: true,
  grarecoSearch: true,
  research: true,
  roomObservation: true,
  googleLogin: true,
  email: true,
};

export interface GoogleNeedsRegistrationResponse {
  needsRegistration: true;
  email: string;
  name: string | null;
}

export interface AuthSession {
  userId: number;
  email: string;
  displayName: string | null;
}

export const PRODUCT_NAME = 'Realtime GraReco & Search';

export interface SiteConfig {
  appName: string;
  organizationName: string;
  supportEmail: string;
  termsUrl: string;
  privacyUrl: string;
}
