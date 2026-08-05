window.i18nLocales = window.i18nLocales || {};
window.i18nLocales.nl = {
    appName: "Spark",
    appSubtitle: "AI Training HQ",
    
    // Navigatie
    nav: {
        dashboard: "Dashboard",
        chat: "Coach Chat",
        physique: "Fysiek",
        activities: "Activiteiten",
        leaderboard: "Ranglijst",
        settings: "Instellingen",
        logout: "Uitloggen",
        admin: "Beheer HQ"
    },

    // Algemene UI
    common: {
        save: "Opslaan",
        saving: "Opslaan...",
        cancel: "Annuleren",
        delete: "Verwijderen",
        edit: "Bewerken",
        confirm: "Bevestigen",
        close: "Sluiten",
        back: "Terug",
        next: "Volgende",
        done: "Klaar",
        today: "Vandaag",
        yesterday: "Gisteren",
        thisWeek: "Deze Week",
        loading: "Laden...",
        success: "Succes",
        error: "Fout",
        none: "Geen",
        kg: "kg",
        lbs: "lbs",
        bpm: "bpm",
        km: "km",
        mi: "mi",
        min: "min",
        hr: "uur",
        cal: "kcal",
        points: "ptn"
    },

    // Dashboard
    dashboard: {
        title: "Training Dashboard",
        subtitle: "Realtime AI Fitness & Herstel Inzichten",
        readinessScore: "Herstelscore",
        readinessOptimal: "Optimaal Trainingsvenster",
        readinessModerate: "Matig Herstel Aanbevolen",
        readinessFatigued: "Hoge Vermoeidheid - Rust Aanbevolen",
        weeklyVolume: "Wekelijks Volume",
        weeklyTss: "Wekelijkse TSS",
        fitnessScore: "Fitness Niveau (CTL)",
        fatigueScore: "Vermoeidheid (ATL)",
        formScore: "Vorm (TSB)",
        recoveryStatus: "Herstelstatus",
        quickActions: "Snelle Acties",
        logWorkout: "Work-out Loggen",
        logWeight: "Gewicht Loggen",
        askCoach: "Vraag Coach Nana",
        recentActivities: "Recente Activiteiten",
        viewAllActivities: "Bekijk Alles",
        noRecentActivities: "Nog geen recente activiteiten gelogd.",
        physiqueProgress: "Fysieke Voortgang",
        latestWeight: "Laatste Gewicht",
        targetWeight: "Doelgewicht",
        bodyFat: "Vetpercentage %",
        aiRecommendation: "AI Dagelijks Advies",
        refreshAi: "Vernieuw Advies"
    },

    // AI Coach / Chat
    chat: {
        title: "AI Fitness Coach",
        subtitle: "Gepersonaliseerd AI training-, voeding- en hersteladvies",
        personaSelector: "Coach Persona",
        personaLiana: "Coach Liana (Ondersteunend & Inlevend)",
        personaMarcus: "Coach Marcus (Direct & Hoge Intensiteit)",
        personaDrChen: "Dr. Chen (Wetenschappelijk & Analytisch)",
        inputPlaceholder: "Stel een vraag over je training, voeding of herstel...",
        sendButton: "Versturen",
        typing: "Coach Nana denkt na...",
        dailyMessagesLeft: "{count} berichten over vandaag",
        contextInfo: "Gebruikt recente activiteit & gezondheidsgegevens",
        clearHistory: "Chat Wissen",
        clearHistoryConfirm: "Weet je zeker dat je de chatgeschiedenis wilt wissen?",
        suggestedQuestions: "Voorgestelde Vragen:",
        suggested1: "Hoe kan ik mijn workouts deze week het beste indelen?",
        suggested2: "Wat is mijn huidige herstel paraatheid?",
        suggested3: "Kun je mij een voedingsschema voor na de workout geven?"
    },

    // Physique / Fysiek
    physique: {
        title: "Fysiek & Lichaam Metrieken",
        subtitle: "Volg gewicht, vetpercentage % en foto transformaties",
        logMetrics: "Nieuwe Metrieken Loggen",
        weightInput: "Lichaamsgewicht",
        bodyFatInput: "Vetpercentage % (Optioneel)",
        notesInput: "Notities / Dagboek",
        uploadPhoto: "Voortgangsfoto Uploaden",
        saveEntry: "Metrieken Opslaan",
        photoComparison: "Transformatie Slider",
        beforePhoto: "Voor",
        afterPhoto: "Na",
        selectDates: "Selecteer Datums om te Vergelijken",
        weightHistory: "Gewichtsverloop",
        noEntries: "Nog geen fysieke metrieken vastgelegd.",
        deleteConfirm: "Deze fysieke meting verwijderen?"
    },

    // Activities / Activiteiten
    activities: {
        title: "Activiteiten & Workouts",
        subtitle: "Gesynchroniseerde Strava, Garmin en handmatige logs",
        syncStrava: "Strava Synchroniseren",
        syncGarmin: "Garmin Synchroniseren",
        logManual: "Handmatige Workout Loggen",
        activityType: "Type Activiteit",
        duration: "Duur (minuten)",
        distance: "Afstand (km)",
        avgHr: "Gem. Hartslag (bpm)",
        calories: "Verbrande Calorieën",
        perceivedExertion: "RPE Zwaarte (1-10)",
        notes: "Activiteit Notities",
        saveActivity: "Activiteit Opslaan",
        running: "Hardlopen",
        cycling: "Wielrennen / Fietsen",
        swimming: "Zwemmen",
        strength: "Krachttraining",
        walking: "Wandelen",
        hiit: "HIIT Workout",
        other: "Overige Activiteit",
        noActivities: "Geen activiteiten gevonden. Verbind Garmin/Strava of log handmatig."
    },

    // Leaderboard / Ranglijst
    leaderboard: {
        title: "Wereldwijde Ranglijst",
        subtitle: "Strijd met atleten en blijf gemotiveerd",
        rank: "Rang",
        athlete: "Atleet",
        level: "Niveau",
        totalPoints: "Spark Punten",
        weeklyStreak: "Reeks",
        yourRank: "Jouw Huidige Positie",
        levelTitle: "Niveau {level} Atleet",
        streakDays: "{count} Dagen Reeks 🔥",
        achievements: "Prestaties & Badges"
    },

    // Settings / Instellingen
    settings: {
        title: "App Instellingen & Profiel",
        subtitle: "Beheer account, koppelingen en voorkeuren",
        profileInfo: "Profiel Informatie",
        name: "Weergavenaam",
        email: "E-mailadres",
        language: "App Taal",
        languageDesc: "Kies de gewenste taal voor de interface en de AI coach",
        theme: "Kleurthema",
        themeAuto: "Systeem (Auto)",
        themeDark: "Midnight Slate (Donker)",
        themeLight: "Solar Velocity (Licht)",
        integrations: "Koppelingen & Apparaten",
        connectStrava: "Verbind Strava",
        stravaConnected: "Strava Verbonden ✓",
        connectGarmin: "Verbind Garmin",
        garminConnected: "Garmin Verbonden ✓",
        saveSettings: "Voorkeuren Opslaan",
        settingsSaved: "Instellingen succesvol opgeslagen!"
    },

    // Alerts / Meldingen
    alerts: {
        loggedSuccess: "Succesvol opgeslagen!",
        syncComplete: "Synchronisatie voltooid!",
        errorOccurred: "Er is een fout opgetreden. Probeer het opnieuw.",
        unauthorized: "Log in om door te gaan.",
        networkError: "Netwerkverbinding fout."
    }
};
