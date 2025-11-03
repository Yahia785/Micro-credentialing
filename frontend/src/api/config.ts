import { fetchAuthSession, fetchUserAttributes } from 'aws-amplify/auth';

// Use proxy in development, direct API in production
export const API_BASE = import.meta.env.DEV 
  ? '/api'  // Development: Use Vite proxy
  : import.meta.env.VITE_API_ENDPOINT;  // Production: Direct API call

/**
 * Get authentication token
 */
export async function getAuthToken(): Promise<string> {
  try {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();
    if (!token) {
      throw new Error('No authentication token available');
    }
    return token;
  } catch (error) {
    console.error('Error getting auth token:', error);
    throw error;
  }
}

/**
 * Get current user attributes from Cognito
 */
export async function getCurrentUserAttributes() {
  try {
    const attributes = await fetchUserAttributes();
    return {
      email: attributes.email || '',
      name: attributes.name || attributes.email?.split('@')[0] || 'User'
    };
  } catch (error) {
    console.error('Error fetching user attributes:', error);
    throw error;
  }
}