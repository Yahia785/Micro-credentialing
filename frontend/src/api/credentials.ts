import { getAuthToken, API_BASE } from './config';

/**
 * Credential interface
 */
export interface Credential {
  credentialId: string;
  userId: string;
  milestoneId: string;
  submissionId: string;
  bcdiplomaKey: string;
  bcdiplomaUrl: string;
  bcdiplomaBadgeUrl?: string;
  bcdiplomaTemplateId: string;
  issuedAt: string;
  expiresAt: string | null;
  recipientName: string;
  recipientEmail: string;
  problemTitle: string;
  score: number;
  status: 'issued' | 'revoked';
  createdAt: string;
}

/**
 * Get all credentials for the current user
 */
export async function getUserCredentials(): Promise<{ credentials: Credential[] }> {
  const token = await getAuthToken();

  console.log('Fetching user credentials from:', `${API_BASE}/credentials`);

  const response = await fetch(`${API_BASE}/credentials`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Get credentials failed:', response.status, errorText);
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}

/**
 * Get a specific credential by ID
 */
export async function getCredential(credentialId: string): Promise<{ credential: Credential }> {
  const token = await getAuthToken();

  console.log('Fetching credential:', credentialId);

  const response = await fetch(`${API_BASE}/credentials/${credentialId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Get credential failed:', response.status, errorText);
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}