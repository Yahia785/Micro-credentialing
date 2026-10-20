import { useState } from 'react';
import { Button, Card, PageHeader } from '../components/ui';
import { EditProfile } from '../components/EditProfile';
import { useUser } from '../context/UserContext';
import type { UserProfile } from '../types/user';
import styles from './ProfilePage.module.css';

export function ProfilePage() {
  const { userProfile, setUserProfile } = useUser();
  const [isEditing, setIsEditing] = useState(false);

  const handleUpdateSuccess = (updatedUser: UserProfile) => {
    setUserProfile(updatedUser);
    setIsEditing(false);
  };

  return (
    <>
      <PageHeader title="Profile" subtitle="Your account details." />
      {userProfile && !isEditing && (
        <Card
          footer={
            <Button variant="secondary" onClick={() => setIsEditing(true)}>
              Edit profile
            </Button>
          }
        >
          <dl className={styles.details}>
            <dt>Email</dt>
            <dd>{userProfile.email}</dd>
            <dt>Name</dt>
            <dd>{userProfile.name}</dd>
            <dt>Member since</dt>
            <dd>{new Date(userProfile.createdAt).toLocaleDateString()}</dd>
          </dl>
        </Card>
      )}

      {userProfile && isEditing && (
        <EditProfile
          currentUser={userProfile}
          onUpdateSuccess={handleUpdateSuccess}
          onCancel={() => setIsEditing(false)}
        />
      )}
    </>
  );
}
