import React, { useState, useRef, useEffect } from 'react';
import { 
  StyleSheet, 
  Text, 
  View, 
  TouchableOpacity, 
  TextInput, 
  Alert,
  Dimensions,
  ScrollView 
} from 'react-native';
import { CameraView, CameraType, useCameraPermissions } from 'expo-camera';
import { Video, ResizeMode } from 'expo-av';
import * as ImagePicker from 'expo-image-picker';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import { addAnalysis } from '../store/slices/historySlice';
import { mockFoodDetectionService } from '../services/MockFoodDetection';

const { width, height } = Dimensions.get('window');

export default function VideoTextTab() {
  const dispatch = useAppDispatch();
  const user = useAppSelector((state) => state.auth.user);
  const [facing, setFacing] = useState<CameraType>('back');
  const [permission, requestPermission] = useCameraPermissions();
  const [isRecording, setIsRecording] = useState(false);
  const [recordedVideo, setRecordedVideo] = useState<string | null>(null);
  const [textInput, setTextInput] = useState('');
  const [useFallback, setUseFallback] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<string | null>(null);
  const [recordingTime, setRecordingTime] = useState(0);
  const cameraRef = useRef<CameraView>(null);
  const recordingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const recordingPromiseRef = useRef<Promise<{ uri: string } | undefined> | null>(null);

  if (!permission) {
    return <View />;
  }

  if (!permission.granted) {
    return (
      <View style={styles.container}>
        <Text style={styles.message}>We need your permission to show the camera</Text>
        <TouchableOpacity onPress={requestPermission} style={styles.button}>
          <Text style={styles.buttonText}>Grant Permission</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const toggleCameraFacing = () => {
    setFacing(current => (current === 'back' ? 'front' : 'back'));
  };

  const startRecording = async () => {
    if (cameraRef.current) {
      try {
        setIsRecording(true);
        setRecordingTime(0);
        console.log('[Video] Starting recording...');
        
        // Start timer
        recordingIntervalRef.current = setInterval(() => {
          setRecordingTime(prev => prev + 1);
        }, 1000);
        
        // Start recording and store the promise
        recordingPromiseRef.current = cameraRef.current.recordAsync({
          maxDuration: 5, // Hard limit to 5 seconds
          quality: '720p',
        });
        
        // Handle the promise when recording stops
        const promise = recordingPromiseRef.current;
        if (promise) {
          promise
            .then((video) => {
              console.log('[Video] Recording completed:', video?.uri);
              setRecordedVideo(video?.uri || null);
              Alert.alert('Success', 'Video recorded successfully!');
            })
            .catch((error) => {
              Alert.alert('Error', 'Failed to record video');
              console.error('Recording error:', error);
            })
            .finally(() => {
              setIsRecording(false);
              if (recordingIntervalRef.current) {
                clearInterval(recordingIntervalRef.current);
                recordingIntervalRef.current = null;
              }
              setRecordingTime(0);
              recordingPromiseRef.current = null;
            });
        }
      } catch (error) {
        Alert.alert('Error', 'Failed to start recording');
        console.error('Recording start error:', error);
        setIsRecording(false);
        if (recordingIntervalRef.current) {
          clearInterval(recordingIntervalRef.current);
          recordingIntervalRef.current = null;
        }
        setRecordingTime(0);
      }
    }
  };

  const stopRecording = () => {
    if (cameraRef.current && isRecording) {
      console.log('[Video] Stopping recording...');
      try {
        cameraRef.current.stopRecording();
      } catch (error) {
        console.error('[Video] Error stopping recording:', error);
        setIsRecording(false);
        if (recordingIntervalRef.current) {
          clearInterval(recordingIntervalRef.current);
          recordingIntervalRef.current = null;
        }
        setRecordingTime(0);
      }
    }
  };

  const resetVideo = () => {
    setRecordedVideo(null);
  };

  const pickVideoFromGallery = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['videos'],
        allowsEditing: true,
        videoMaxDuration: 5,
        quality: 1,
      });

      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        const durationSec = asset.duration ? asset.duration / 1000 : 0;
        if (durationSec > 5.5) {
          Alert.alert('Video Too Long', 'Please select a video that is 5 seconds or shorter.');
          return;
        }
        setRecordedVideo(asset.uri);
        Alert.alert('Success', 'Video selected from gallery!');
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to select video from gallery');
      console.error('Gallery error:', error);
    }
  };

  const analyzeVideoText = async () => {
    if (recordedVideo && textInput.trim()) {
      const analysisResult = mockFoodDetectionService.analyzeFood(textInput, 'video');
      const result = mockFoodDetectionService.formatAnalysisResult(analysisResult);
      
      setAnalysisResult(result);
      
      // Save to history
      if (user?.email) {
        const result_action = await dispatch(addAnalysis({
          userEmail: user.email,
          analysis: {
            type: 'video',
            videoUri: recordedVideo,
            textDescription: textInput,
            analysisResult: result,
            nutritionalInfo: { 
              calories: analysisResult.totalCalories, 
              protein: analysisResult.totalProtein, 
              carbs: analysisResult.totalCarbs, 
              fat: analysisResult.totalFat 
            },
          },
        }));
        
        if (addAnalysis.fulfilled.match(result_action)) {
          Alert.alert('Analysis Complete', 'Video and text analysis completed and saved to history!');
        } else {
          Alert.alert('Warning', 'Analysis completed but failed to save to history. Please try again.');
        }
      }
    } else if (recordedVideo) {
      const analysisResult = mockFoodDetectionService.analyzeFood(undefined, 'video');
      const result = mockFoodDetectionService.formatAnalysisResult(analysisResult);
      
      setAnalysisResult(result);
      
      // Save to history
      if (user?.email) {
        await dispatch(addAnalysis({
          userEmail: user.email,
          analysis: {
            type: 'video',
            videoUri: recordedVideo,
            textDescription: textInput || undefined,
            analysisResult: result,
            nutritionalInfo: { 
              calories: analysisResult.totalCalories, 
              protein: analysisResult.totalProtein, 
              carbs: analysisResult.totalCarbs, 
              fat: analysisResult.totalFat 
            },
          },
        }));
      }
      
      Alert.alert('Analysis Complete', 'Video analysis completed and saved to history! Add text for better results.');
    } else if (textInput.trim()) {
      Alert.alert('Add Video', 'Please record or select a video for complete analysis.');
    } else {
      Alert.alert('Add Content', 'Please add both video and text for comprehensive analysis.');
    }
  };

  const clearAll = () => {
    setRecordedVideo(null);
    setTextInput('');
    setAnalysisResult(null);
  };

  return (
    <ScrollView style={styles.container}>
      {/* Video Section */}
      <View style={styles.videoContainer}>
        <Text style={styles.title}>🎥 Video Analysis</Text>
        
        {!recordedVideo ? (
          <>
            {!useFallback ? (
              <CameraView 
                ref={cameraRef}
                style={styles.camera} 
                facing={facing}
                mode="video"
              >
                <View style={styles.cameraControls}>
                  <TouchableOpacity 
                    style={styles.flipButton} 
                    onPress={toggleCameraFacing}
                  >
                    <Text style={styles.buttonText}>Flip</Text>
                  </TouchableOpacity>
                  
                  <TouchableOpacity 
                    style={[styles.recordButton, isRecording && styles.recordingButton]} 
                    onPress={isRecording ? stopRecording : startRecording}
                  >
                    <Text style={styles.buttonText}>
                      {isRecording ? 'Stop' : 'Record'}
                    </Text>
                  </TouchableOpacity>
                  
                  {isRecording && (
                    <View style={styles.recordingIndicator}>
                      <Text style={styles.recordingText}>
                        🔴 Recording: {recordingTime}s
                      </Text>
                    </View>
                  )}
                </View>
              </CameraView>
            ) : (
              <View style={styles.fallbackContainer}>
                <Text style={styles.fallbackText}>📱 Mobile Web Camera Not Available</Text>
                <TouchableOpacity 
                  style={styles.galleryButton} 
                  onPress={pickVideoFromGallery}
                >
                  <Text style={styles.buttonText}>📁 Select Video from Gallery</Text>
                </TouchableOpacity>
                <TouchableOpacity 
                  style={styles.tryCameraButton} 
                  onPress={() => setUseFallback(false)}
                >
                  <Text style={styles.buttonText}>📷 Try Camera Again</Text>
                </TouchableOpacity>
              </View>
            )}
            
            {/* Fallback Toggle Button */}
            <TouchableOpacity 
              style={styles.fallbackToggle} 
              onPress={() => setUseFallback(!useFallback)}
            >
              <Text style={styles.fallbackToggleText}>
                {useFallback ? '📷 Use Camera' : '📁 Use Gallery'}
              </Text>
            </TouchableOpacity>
          </>
        ) : (
          <View style={styles.videoDisplayContainer}>
            <Video
              source={{ uri: recordedVideo }}
              style={styles.video}
              useNativeControls
              resizeMode={ResizeMode.CONTAIN}
            />
            <TouchableOpacity 
              style={styles.changeVideoButton} 
              onPress={resetVideo}
            >
              <Text style={styles.buttonText}>Change Video</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* Text Input Section */}
      <View style={styles.inputContainer}>
        <Text style={styles.title}>📝 Additional Description (Optional)</Text>
        <Text style={styles.subtitle}>Add text to enhance video analysis</Text>
        
        <TextInput
          style={styles.textInput}
          placeholder="Include additional details if you would like to (Optional)"
          value={textInput}
          onChangeText={setTextInput}
          multiline
          numberOfLines={4}
          textAlignVertical="top"
        />
      </View>

      {/* Analysis Section */}
      <View style={styles.analysisContainer}>
        <View style={styles.analysisHeader}>
          <Text style={styles.analysisTitle}>🔍 Analysis</Text>
          <TouchableOpacity 
            style={styles.clearButton}
            onPress={clearAll}
          >
            <Text style={styles.clearButtonText}>Clear All</Text>
          </TouchableOpacity>
        </View>
        
        <TouchableOpacity 
          style={styles.analyzeButton}
          onPress={analyzeVideoText}
        >
          <Text style={styles.buttonText}>🔍 Analyze Video + Text</Text>
        </TouchableOpacity>
        
        {analysisResult && (
          <View style={styles.resultBox}>
            <Text style={styles.resultText}>{analysisResult}</Text>
          </View>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  message: {
    textAlign: 'center',
    paddingBottom: 16,
    fontSize: 18,
    color: '#64748b',
    fontWeight: '500',
  },
  videoContainer: {
    backgroundColor: '#ffffff',
    marginHorizontal: 16,
    marginTop: 16,
    padding: 24,
    borderRadius: 20,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 4,
    },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 8,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 8,
    color: '#1e293b',
    textAlign: 'center',
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 16,
    color: '#64748b',
    marginBottom: 24,
    textAlign: 'center',
    lineHeight: 22,
  },
  camera: {
    height: height * 0.35,
    borderRadius: 16,
    overflow: 'hidden',
  },
  cameraControls: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    padding: 24,
  },
  videoDisplayContainer: {
    alignItems: 'center',
  },
  video: {
    width: width - 80,
    height: (width - 80) * 0.6,
    borderRadius: 16,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 8,
    },
    shadowOpacity: 0.15,
    shadowRadius: 16,
    elevation: 12,
  },
  changeVideoButton: {
    backgroundColor: '#3b82f6',
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: 12,
    shadowColor: '#3b82f6',
    shadowOffset: {
      width: 0,
      height: 4,
    },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  flipButton: {
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 20,
  },
  recordButton: {
    backgroundColor: '#ef4444',
    padding: 20,
    borderRadius: 40,
    width: 80,
    height: 80,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#ef4444',
    shadowOffset: {
      width: 0,
      height: 8,
    },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 12,
  },
  recordingButton: {
    backgroundColor: '#ffffff',
    borderWidth: 4,
    borderColor: '#ef4444',
  },
  recordingIndicator: {
    position: 'absolute',
    top: 24,
    left: 24,
    backgroundColor: 'rgba(0,0,0,0.8)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    flexDirection: 'row',
    alignItems: 'center',
  },
  recordingText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    marginLeft: 8,
  },
  fallbackContainer: {
    height: height * 0.35,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
    backgroundColor: '#f1f5f9',
    borderRadius: 20,
    borderWidth: 2,
    borderColor: '#e2e8f0',
    borderStyle: 'dashed',
    marginVertical: 8,
  },
  fallbackText: {
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 24,
    color: '#1e293b',
  },
  galleryButton: {
    backgroundColor: '#8b5cf6',
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: 12,
    marginBottom: 12,
    minWidth: 200,
    alignItems: 'center',
    shadowColor: '#8b5cf6',
    shadowOffset: {
      width: 0,
      height: 4,
    },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  tryCameraButton: {
    backgroundColor: '#3b82f6',
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: 12,
    minWidth: 200,
    alignItems: 'center',
    shadowColor: '#3b82f6',
    shadowOffset: {
      width: 0,
      height: 4,
    },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  fallbackToggle: {
    position: 'absolute',
    top: 16,
    right: 16,
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 20,
  },
  fallbackToggleText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  inputContainer: {
    backgroundColor: '#ffffff',
    marginHorizontal: 16,
    marginTop: 8,
    padding: 24,
    borderRadius: 20,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 4,
    },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 8,
  },
  textInput: {
    borderWidth: 2,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
    textAlignVertical: 'top',
    backgroundColor: '#f8fafc',
    minHeight: 100,
    fontFamily: 'System',
    lineHeight: 22,
  },
  analysisContainer: {
    backgroundColor: '#ffffff',
    marginHorizontal: 16,
    marginTop: 8,
    padding: 24,
    borderRadius: 20,
    marginBottom: 24,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 4,
    },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 8,
  },
  analysisHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  analysisTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1e293b',
    letterSpacing: -0.5,
  },
  clearButton: {
    backgroundColor: '#ef4444',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
    shadowColor: '#ef4444',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
  },
  clearButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  analyzeButton: {
    backgroundColor: '#10b981',
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 20,
    shadowColor: '#10b981',
    shadowOffset: {
      width: 0,
      height: 6,
    },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 8,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  resultBox: {
    backgroundColor: '#f0fdf4',
    padding: 20,
    borderRadius: 12,
    borderLeftWidth: 4,
    borderLeftColor: '#10b981',
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  resultText: {
    fontSize: 16,
    lineHeight: 24,
    color: '#1e293b',
    fontFamily: 'System',
  },
  button: {
    backgroundColor: '#3b82f6',
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: 12,
    alignItems: 'center',
    shadowColor: '#3b82f6',
    shadowOffset: {
      width: 0,
      height: 4,
    },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
});
