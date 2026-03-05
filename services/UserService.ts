import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert } from 'react-native';
import { getCurrentUser } from 'aws-amplify/auth';
import { dynamoDBService, BusinessProfile as DynamoDBProfile } from './DynamoDBService';
import { saveProfileToS3, loadProfileFromS3 } from './S3UserDataService';

// 🔧 CONFIGURATION: Storage mode
// Set to 'local' for AsyncStorage (development) or 'dynamodb' for AWS DynamoDB (production)
const STORAGE_MODE: 'local' | 'dynamodb' = 'local'; // 👈 Change to 'dynamodb' when AWS is configured

export interface Avatar {
  id: number;
  imgSrc: any;
}

export interface UserAccount {
  userId: string;
  email: string;
  createdAt: number;
  hasCompletedProfile: boolean;
  profileData?: BusinessProfile;
  avatar?: Avatar;
}

export interface BusinessProfile {
  // Step 1 data
  profileImage?: string;
  businessName: string;
  address: string;
  town: string;
  district: string;
  postalCode: string;
  country: string;
  
  // Step 2 data
  menuFile?: any;
  businessCategory: string;
  cuisineType: string;
  primaryServingStyle: string;
  averageDishPrice: string;
  standardMealSize: string;
  businessSize: string;
}

class UserService {
  private USER_ACCOUNT_KEY = 'user_account';
  private USER_PROFILE_KEY = 'user_profile';

  /**
   * Create a new user account after OTP verification
   * Similar to mybeats-mobile's createUserWithEmailAndPassword
   */
  async createUserAccount(email: string, cognitoUserId?: string): Promise<UserAccount> {
    try {
      // If an account already exists for this email, return it as-is so that
      // profile completion state and userId are preserved across logins.
      if (STORAGE_MODE === 'local') {
        const existing = await AsyncStorage.getItem(this.USER_ACCOUNT_KEY);
        if (existing) {
          const parsed: UserAccount = JSON.parse(existing);
          if (parsed.email === email) {
            console.log('[UserService] Returning existing account (preserving state):', parsed.userId);
            return parsed;
          }
        }
      }

      let userId: string;

      if (STORAGE_MODE === 'dynamodb' && cognitoUserId) {
        // Use Cognito user ID when using DynamoDB
        userId = cognitoUserId;
        console.log('[UserService] Using Cognito user ID:', userId);
      } else {
        // Generate local user ID for local storage
        userId = `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      }

      const userAccount: UserAccount = {
        userId,
        email,
        createdAt: Date.now(),
        hasCompletedProfile: false,
      };

      // Only save to local storage if using local mode
      if (STORAGE_MODE === 'local') {
        await AsyncStorage.setItem(this.USER_ACCOUNT_KEY, JSON.stringify(userAccount));
      }

      console.log(`[UserService] User account created (${STORAGE_MODE}):`, userId);

      return userAccount;
    } catch (error) {
      console.error('[UserService] Error creating user account:', error);
      throw error;
    }
  }

  /**
   * Get the current user account
   */
  async getUserAccount(): Promise<UserAccount | null> {
    try {
      if (STORAGE_MODE === 'dynamodb') {
        // Get user from Cognito
        try {
          const cognitoUser = await getCurrentUser();
          return {
            userId: cognitoUser.userId,
            email: cognitoUser.username,
            createdAt: Date.now(), // Could store this in Cognito attributes
            hasCompletedProfile: false, // Will check DynamoDB for this
          };
        } catch (error) {
          console.log('[UserService] No Cognito user found');
          return null;
        }
      } else {
        // Get from local storage
        const accountString = await AsyncStorage.getItem(this.USER_ACCOUNT_KEY);
        if (accountString) {
          return JSON.parse(accountString);
        }

        // Local is empty (new device / reinstall) — check Cognito + S3
        try {
          const cognitoUser = await getCurrentUser();
          const email = (cognitoUser.signInDetails?.loginId as string | undefined) || cognitoUser.username;
          let hasCompletedProfile = false;
          try {
            const s3Profile = await loadProfileFromS3(email);
            if (s3Profile && (s3Profile as any).hasCompletedProfile) {
              hasCompletedProfile = true;
              await AsyncStorage.setItem(this.USER_PROFILE_KEY, JSON.stringify(s3Profile));
              await AsyncStorage.setItem('business_profile_completed', 'true');
            }
          } catch { /* S3 not available */ }
          const account: UserAccount = { userId: cognitoUser.userId, email, createdAt: Date.now(), hasCompletedProfile };
          await AsyncStorage.setItem(this.USER_ACCOUNT_KEY, JSON.stringify(account));
          return account;
        } catch {
          return null;
        }
      }
    } catch (error) {
      console.error('[UserService] Error getting user account:', error);
      return null;
    }
  }

  /**
   * Save complete business profile and mark profile as completed
   * Similar to mybeats-mobile's setProfileDataOnFirebase
   */
  async saveBusinessProfile(profileData: BusinessProfile): Promise<boolean> {
    try {
      // Get current user account
      const account = await this.getUserAccount();
      if (!account) {
        throw new Error('No user account found. Please log in again.');
      }

      if (STORAGE_MODE === 'dynamodb') {
        // Save to DynamoDB
        console.log('[UserService] 💾 Saving profile to DynamoDB...');
        
        const dynamoProfile: DynamoDBProfile = {
          userId: account.userId,
          businessName: profileData.businessName,
          address: profileData.address,
          town: profileData.town,
          district: profileData.district,
          postalCode: profileData.postalCode,
          country: profileData.country,
          businessCategory: profileData.businessCategory,
          cuisineType: profileData.cuisineType,
          primaryServingStyle: profileData.primaryServingStyle,
          averageDishPrice: profileData.averageDishPrice,
          standardMealSize: profileData.standardMealSize,
          businessSize: profileData.businessSize,
          profileImage: profileData.profileImage,
          menuFileUrl: profileData.menuFile ? 's3://...' : undefined, // TODO: Upload to S3
          hasCompletedProfile: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        await dynamoDBService.saveBusinessProfile(account.userId, dynamoProfile);
        console.log('[UserService] ✅ Profile saved to DynamoDB successfully');
      } else {
        // Save to local storage
        const updatedAccount: UserAccount = {
          ...account,
          hasCompletedProfile: true,
          profileData,
        };

        await AsyncStorage.setItem(this.USER_ACCOUNT_KEY, JSON.stringify(updatedAccount));
        await AsyncStorage.setItem(this.USER_PROFILE_KEY, JSON.stringify(profileData));
        await AsyncStorage.setItem('business_profile_completed', 'true');
        console.log('[UserService] ✅ Profile saved to local storage successfully');

        // Sync to S3 in background (fire-and-forget)
        saveProfileToS3(account.email, { ...profileData, hasCompletedProfile: true })
          .then(ok => {
            if (ok) console.log('[UserService] ✅ Profile synced to S3');
            else console.warn('[UserService] ⚠️ Profile S3 sync returned false');
          })
          .catch(e => console.warn('[UserService] ⚠️ Profile S3 sync error:', e));
      }
      
      console.log('[UserService] Profile data:', profileData);
      return true;
    } catch (error) {
      console.error('[UserService] Error saving business profile:', error);
      Alert.alert('Error', 'Failed to save profile. Please try again.');
      return false;
    }
  }

  /**
   * Get the business profile
   */
  async getBusinessProfile(): Promise<BusinessProfile | null> {
    try {
      const account = await this.getUserAccount();
      if (!account) {
        return null;
      }

      if (STORAGE_MODE === 'dynamodb') {
        // Get from DynamoDB
        const dynamoProfile = await dynamoDBService.getBusinessProfile(account.userId);
        if (!dynamoProfile) {
          return null;
        }

        // Convert DynamoDB profile to local format
        return {
          profileImage: dynamoProfile.profileImage,
          businessName: dynamoProfile.businessName,
          address: dynamoProfile.address,
          town: dynamoProfile.town,
          district: dynamoProfile.district,
          postalCode: dynamoProfile.postalCode,
          country: dynamoProfile.country,
          businessCategory: dynamoProfile.businessCategory,
          cuisineType: dynamoProfile.cuisineType,
          primaryServingStyle: dynamoProfile.primaryServingStyle,
          averageDishPrice: dynamoProfile.averageDishPrice,
          standardMealSize: dynamoProfile.standardMealSize,
          businessSize: dynamoProfile.businessSize,
          menuFile: dynamoProfile.menuFileUrl ? { uri: dynamoProfile.menuFileUrl } : undefined,
        };
      } else {
        // Get from local storage
        const profileString = await AsyncStorage.getItem(this.USER_PROFILE_KEY);
        if (profileString) {
          const profile = JSON.parse(profileString);
          // Opportunistically sync to S3 if not already there (fire-and-forget)
          loadProfileFromS3(account.email).then(existing => {
            if (!existing) {
              saveProfileToS3(account.email, { ...profile, hasCompletedProfile: true })
                .then(ok => { if (ok) console.log('[UserService] ✅ Back-filled profile to S3'); })
                .catch(() => {});
            }
          }).catch(() => {});
          return profile;
        }
        // Not in local (new device) — try S3
        try {
          const s3Profile = await loadProfileFromS3(account.email);
          if (s3Profile) {
            await AsyncStorage.setItem(this.USER_PROFILE_KEY, JSON.stringify(s3Profile));
            return s3Profile as BusinessProfile;
          }
        } catch { /* S3 not available */ }
        return null;
      }
    } catch (error) {
      console.error('[UserService] Error getting business profile:', error);
      return null;
    }
  }

  /**
   * Update specific profile fields
   */
  async updateProfileFields(updates: Partial<BusinessProfile>): Promise<boolean> {
    try {
      const currentProfile = await this.getBusinessProfile();
      if (!currentProfile) {
        throw new Error('No profile found');
      }

      const updatedProfile = {
        ...currentProfile,
        ...updates,
      };

      await this.saveBusinessProfile(updatedProfile);
      return true;
    } catch (error) {
      console.error('[UserService] Error updating profile fields:', error);
      return false;
    }
  }

  /**
   * Check if user has completed their profile
   */
  async hasCompletedProfile(): Promise<boolean> {
    try {
      if (STORAGE_MODE === 'dynamodb') {
        // Check DynamoDB
        const account = await this.getUserAccount();
        if (!account) {
          return false;
        }
        const profile = await dynamoDBService.getBusinessProfile(account.userId);
        return profile?.hasCompletedProfile || false;
      } else {
        // Check local storage
        const account = await this.getUserAccount();
        return account?.hasCompletedProfile || false;
      }
    } catch (error) {
      console.error('[UserService] Error checking profile completion:', error);
      return false;
    }
  }

  /**
   * Anonymize user email while preserving data for research purposes
   */
  private generateAnonymizedEmail(originalEmail: string, type: 'deleted' | 'withdrawn'): string {
    const timestamp = Date.now();
    const userId = originalEmail.split('@')[0].substring(0, 8); // First 8 chars of email prefix
    return `${type}_user_${userId}_${timestamp}@anonymized.local`;
  }

  /**
   * Anonymize user account - replaces email but keeps all other data
   */
  async anonymizeUserAccount(type: 'deleted' | 'withdrawn'): Promise<void> {
    try {
      const account = await this.getUserAccount();
      if (!account) {
        throw new Error('No user account found');
      }

      const originalEmail = account.email;
      const anonymizedEmail = this.generateAnonymizedEmail(originalEmail, type);

      // Update account with anonymized email
      const anonymizedAccount: UserAccount = {
        ...account,
        email: anonymizedEmail,
      };

      if (STORAGE_MODE === 'local') {
        await AsyncStorage.setItem(this.USER_ACCOUNT_KEY, JSON.stringify(anonymizedAccount));
        
        // Update user in auth storage
        await AsyncStorage.setItem('user', JSON.stringify({
          email: anonymizedEmail,
          isVerified: false,
        }));

        // Update history entries to use anonymized email
        await this.anonymizeHistoryData(originalEmail, anonymizedEmail);
        
        // Update feedback data to use anonymized email
        await this.anonymizeFeedbackData(originalEmail, anonymizedEmail);

        console.log('[UserService] User account anonymized:', {
          original: originalEmail,
          anonymized: anonymizedEmail,
          type,
        });
      } else {
        // TODO: Update DynamoDB when using DynamoDB mode
        console.log('[UserService] User account would be anonymized in DynamoDB');
      }
    } catch (error) {
      console.error('[UserService] Error anonymizing user account:', error);
      throw error;
    }
  }

  /**
   * Anonymize history data by updating email references
   */
  private async anonymizeHistoryData(originalEmail: string, anonymizedEmail: string): Promise<void> {
    try {
      const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
      const historyKey = `history_${originalEmail}`;
      const historyData = await AsyncStorage.getItem(historyKey);
      
      if (historyData) {
        // Save history with anonymized email key
        const newHistoryKey = `history_${anonymizedEmail}`;
        await AsyncStorage.setItem(newHistoryKey, historyData);
        
        // Remove old history key
        await AsyncStorage.removeItem(historyKey);
        
        console.log('[UserService] History data anonymized (AsyncStorage)');
      }

      // Also handle mock API's in-memory data structure (for React Native)
      // The mock API stores data in memory, so we need to update it if it exists
      try {
        const { historyAPI } = await import('./HistoryAPI');
        // Access the mock API's internal data structure
        // Note: This is a workaround for the mock API - in production, this would be handled by the backend
        const mockDataKey = `mockHistoryData`;
        const mockDataStr = await AsyncStorage.getItem(mockDataKey);
        
        if (mockDataStr) {
          const mockData = JSON.parse(mockDataStr);
          if (mockData[originalEmail]) {
            // Move data to anonymized email key
            mockData[anonymizedEmail] = mockData[originalEmail];
            delete mockData[originalEmail];
            await AsyncStorage.setItem(mockDataKey, JSON.stringify(mockData));
            console.log('[UserService] History data anonymized (Mock API)');
          }
        }
      } catch (mockError) {
        // Mock API might not be available, ignore
        console.log('[UserService] Mock API data not found or not accessible');
      }
    } catch (error) {
      console.error('[UserService] Error anonymizing history data:', error);
    }
  }

  /**
   * Anonymize feedback data by updating email references
   */
  private async anonymizeFeedbackData(originalEmail: string, anonymizedEmail: string): Promise<void> {
    try {
      const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
      const feedbackKey = `feedback_${originalEmail}`;
      const feedbackData = await AsyncStorage.getItem(feedbackKey);
      
      if (feedbackData) {
        // Save feedback with anonymized email key
        const newFeedbackKey = `feedback_${anonymizedEmail}`;
        await AsyncStorage.setItem(newFeedbackKey, feedbackData);
        
        // Remove old feedback key
        await AsyncStorage.removeItem(feedbackKey);
        
        console.log('[UserService] Feedback data anonymized');
      }
    } catch (error) {
      console.error('[UserService] Error anonymizing feedback data:', error);
    }
  }

  /**
   * Delete user account - anonymizes email instead of deleting data
   */
  async deleteUserAccount(): Promise<void> {
    try {
      await this.anonymizeUserAccount('deleted');
      
      // Mark account as deleted
      await AsyncStorage.setItem('account_deleted', 'true');
      await AsyncStorage.setItem('account_deleted_date', new Date().toISOString());
      
      console.log('[UserService] User account deleted (anonymized)');
    } catch (error) {
      console.error('[UserService] Error deleting user account:', error);
      throw error;
    }
  }

  /**
   * Withdraw user participation - anonymizes email instead of deleting data
   */
  async withdrawParticipation(): Promise<void> {
    try {
      await this.anonymizeUserAccount('withdrawn');
      
      // Mark user as withdrawn
      await AsyncStorage.setItem('user_withdrawn', 'true');
      await AsyncStorage.setItem('withdrawal_date', new Date().toISOString());
      
      console.log('[UserService] User participation withdrawn (anonymized)');
    } catch (error) {
      console.error('[UserService] Error withdrawing participation:', error);
      throw error;
    }
  }

  /**
   * Set the selected avatar for the user
   */
  async setAvatar(avatar: Avatar): Promise<boolean> {
    try {
      const account = await this.getUserAccount();
      if (!account) {
        throw new Error('No user account found. Please log in again.');
      }

      const updatedAccount: UserAccount = {
        ...account,
        avatar,
      };

      if (STORAGE_MODE === 'local') {
        await AsyncStorage.setItem(this.USER_ACCOUNT_KEY, JSON.stringify(updatedAccount));
        console.log('[UserService] ✅ Avatar saved to local storage');
      } else {
        // TODO: Save to DynamoDB when using DynamoDB mode
        console.log('[UserService] Avatar would be saved to DynamoDB');
      }

      return true;
    } catch (error) {
      console.error('[UserService] Error setting avatar:', error);
      return false;
    }
  }

  /**
   * Get the user's avatar
   */
  async getAvatar(): Promise<Avatar | null> {
    try {
      const account = await this.getUserAccount();
      if (!account?.avatar) {
        return null;
      }
      
      // Reconstruct avatar from avatarList to ensure imgSrc is properly set
      // When avatar is saved to JSON, imgSrc (require() result) becomes a number
      // We need to map it back to the actual avatar from avatarList
      const { avatarList } = await import('../constants/avatarConstants');
      const savedAvatar = account.avatar;
      const reconstructedAvatar = avatarList.find(av => av.id === savedAvatar.id);
      
      if (reconstructedAvatar) {
        console.log('[UserService] Avatar reconstructed from avatarList:', reconstructedAvatar.id);
        return reconstructedAvatar;
      }
      
      // Fallback: return saved avatar if reconstruction fails
      console.log('[UserService] Avatar not found in avatarList, using saved avatar');
      return savedAvatar;
    } catch (error) {
      console.error('[UserService] Error getting avatar:', error);
      return null;
    }
  }

  /**
   * Get user statistics (for display purposes)
   */
  async getUserStats() {
    try {
      const account = await this.getUserAccount();
      const profile = await this.getBusinessProfile();
      
      return {
        userId: account?.userId,
        email: account?.email,
        memberSince: account?.createdAt,
        businessName: profile?.businessName,
        businessCategory: profile?.businessCategory,
        hasCompletedProfile: account?.hasCompletedProfile,
        avatar: account?.avatar,
      };
    } catch (error) {
      console.error('[UserService] Error getting user stats:', error);
      return null;
    }
  }
}

// Export singleton instance
export const userService = new UserService();

