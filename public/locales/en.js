window.i18nLocales = window.i18nLocales || {};
window.i18nLocales.en = {
    appName: "Spark",
    appSubtitle: "AI Training HQ",
    
    // Navigation
    nav: {
        dashboard: "Dashboard",
        chat: "Coach Chat",
        physique: "Physique",
        activities: "Activities",
        leaderboard: "Leaderboard",
        settings: "Settings",
        logout: "Logout",
        admin: "Admin HQ"
    },

    // Common UI
    common: {
        save: "Save",
        saving: "Saving...",
        cancel: "Cancel",
        delete: "Delete",
        edit: "Edit",
        confirm: "Confirm",
        close: "Close",
        back: "Back",
        next: "Next",
        done: "Done",
        today: "Today",
        yesterday: "Yesterday",
        thisWeek: "This Week",
        loading: "Loading...",
        success: "Success",
        error: "Error",
        none: "None",
        kg: "kg",
        lbs: "lbs",
        bpm: "bpm",
        km: "km",
        mi: "mi",
        min: "min",
        hr: "hr",
        cal: "kcal",
        points: "pts"
    },

    // Dashboard
    dashboard: {
        title: "Training Dashboard",
        subtitle: "Real-time AI Fitness & Recovery Insights",
        readinessScore: "Readiness Score",
        readinessOptimal: "Optimal Training Window",
        readinessModerate: "Moderate Recovery Recommended",
        readinessFatigued: "High Fatigue - Rest Recommended",
        weeklyVolume: "Weekly Volume",
        weeklyTss: "Weekly TSS",
        fitnessScore: "Fitness Level (CTL)",
        fatigueScore: "Fatigue (ATL)",
        formScore: "Form (TSB)",
        recoveryStatus: "Recovery Status",
        quickActions: "Quick Actions",
        logWorkout: "Log Workout",
        logWeight: "Log Weight",
        askCoach: "Ask Coach Nana",
        recentActivities: "Recent Activities",
        viewAllActivities: "View All",
        noRecentActivities: "No recent activities logged yet.",
        physiqueProgress: "Physique Progress",
        latestWeight: "Latest Weight",
        targetWeight: "Target Weight",
        bodyFat: "Body Fat %",
        aiRecommendation: "AI Daily Recommendation",
        refreshAi: "Refresh Recommendation"
    },

    // AI Coach / Chat
    chat: {
        title: "AI Fitness Coach",
        subtitle: "Personalized AI training, nutrition, and recovery advice",
        personaSelector: "Coach Persona",
        personaLiana: "Coach Liana (Supportive & Empathetic)",
        personaMarcus: "Coach Marcus (Direct & High Intensity)",
        personaDrChen: "Dr. Chen (Scientific & Analytical)",
        inputPlaceholder: "Ask about your training, nutrition, or recovery...",
        sendButton: "Send",
        typing: "Coach Nana is thinking...",
        dailyMessagesLeft: "{count} messages remaining today",
        contextInfo: "Using latest activity & health metrics context",
        clearHistory: "Clear Chat",
        clearHistoryConfirm: "Are you sure you want to clear your chat history?",
        suggestedQuestions: "Suggested Questions:",
        suggested1: "How should I structure my workouts this week?",
        suggested2: "What is my current recovery readiness?",
        suggested3: "Can you give me a post-workout meal plan?"
    },

    // Physique Section
    physique: {
        title: "Physique & Body Metrics",
        subtitle: "Track body weight, body fat %, and photo transformations",
        logMetrics: "Log New Metrics",
        weightInput: "Body Weight",
        bodyFatInput: "Body Fat % (Optional)",
        notesInput: "Notes / Journal",
        uploadPhoto: "Upload Progress Photo",
        saveEntry: "Save Log Entry",
        photoComparison: "Transformation Slider",
        beforePhoto: "Before",
        afterPhoto: "After",
        selectDates: "Select Dates to Compare",
        weightHistory: "Weight History",
        noEntries: "No physique entries recorded yet.",
        deleteConfirm: "Delete this physique entry?"
    },

    // Activities Section
    activities: {
        title: "Activities & Workouts",
        subtitle: "Synced Strava, Garmin, and manual training logs",
        syncStrava: "Sync Strava",
        syncGarmin: "Sync Garmin",
        logManual: "Log Manual Workout",
        activityType: "Activity Type",
        duration: "Duration (minutes)",
        distance: "Distance (km)",
        avgHr: "Avg Heart Rate (bpm)",
        calories: "Calories Burned",
        perceivedExertion: "RPE (1-10)",
        notes: "Activity Notes",
        saveActivity: "Save Activity",
        running: "Running",
        cycling: "Cycling",
        swimming: "Swimming",
        strength: "Strength Training",
        walking: "Walking",
        hiit: "HIIT Workout",
        other: "Other Activity",
        noActivities: "No activities found. Connect Garmin/Strava or log manually."
    },

    // Leaderboard & Gamification
    leaderboard: {
        title: "Global Leaderboard",
        subtitle: "Compete with athletes and stay accountable",
        rank: "Rank",
        athlete: "Athlete",
        level: "Level",
        totalPoints: "Spark Points",
        weeklyStreak: "Streak",
        yourRank: "Your Current Rank",
        levelTitle: "Level {level} Athlete",
        streakDays: "{count} Day Streak 🔥",
        achievements: "Achievements & Badges"
    },

    // Settings
    settings: {
        title: "App Settings & Profile",
        subtitle: "Manage account, integrations, and preferences",
        profileInfo: "Profile Information",
        name: "Display Name",
        email: "Email Address",
        language: "App Language",
        languageDesc: "Choose your preferred interface and AI coach language",
        theme: "Color Theme",
        themeAuto: "System (Auto)",
        themeDark: "Midnight Slate (Dark)",
        themeLight: "Solar Velocity (Light)",
        integrations: "Integrations & Devices",
        connectStrava: "Connect Strava",
        stravaConnected: "Strava Connected ✓",
        connectGarmin: "Connect Garmin",
        garminConnected: "Garmin Connected ✓",
        saveSettings: "Save Preferences",
        settingsSaved: "Settings saved successfully!"
    },

    // Notifications & Toasts
    alerts: {
        loggedSuccess: "Log saved successfully!",
        syncComplete: "Activity sync complete!",
        errorOccurred: "An error occurred. Please try again.",
        unauthorized: "Please log in to continue.",
        networkError: "Network connection error."
    }
};
