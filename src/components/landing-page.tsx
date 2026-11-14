"use client";

import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Image as ImageIcon,
  Video,
  ShieldCheck,
  Zap,
  HardDrive,
  Lock,
  ArrowRight,
  Check,
  Star,
  UploadCloud,
  ChevronRight,
  Sparkles,
  LogIn,
  X,
  Camera,
  Film,
  Flame,
  AlertCircle,
  Database,
  Mail,
  Eye,
  EyeOff,
  User as UserIcon,
} from "lucide-react";
import { AppLogo } from "@/components/app-logo";
import { User, setStoredUser } from "@/lib/auth";
import { STORAGE_PLANS } from "@/lib/plans";
import {
  auth,
  googleProvider,
  createOrUpdateUserProfile,
  fetchUserProfile,
} from "@/lib/firebase";
import {
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  sendEmailVerification,
} from "firebase/auth";
import {
  KeyRound,
  CheckCircle2,
  RefreshCw,
  ArrowLeft,
} from "lucide-react";

interface LandingPageProps {
  currentUser: User | null;
  onLoginSuccess: (user: User) => void;
  onEnterVault: () => void;
  onSelectPlanUpgrade?: (planId: "100mb" | "50gb" | "250gb" | "1tb") => void;
}

export function LandingPage({
  currentUser,
  onLoginSuccess,
  onEnterVault,
  onSelectPlanUpgrade,
}: LandingPageProps) {
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signup");
  const [authStep, setAuthStep] = useState<"form" | "forgot" | "await_verification">("form");
  const [selectedPlanId, setSelectedPlanId] = useState<"100mb" | "50gb" | "250gb" | "1tb">("100mb");
  const [emailInput, setEmailInput] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [showModalPassword, setShowModalPassword] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authSuccessMsg, setAuthSuccessMsg] = useState("");

  const handleOpenAuth = (mode: "signin" | "signup", planId: "100mb" | "50gb" | "250gb" | "1tb" = "100mb") => {
    setAuthMode(mode);
    setAuthStep("form");
    setSelectedPlanId(planId);
    setAuthError("");
    setAuthSuccessMsg("");
    setShowAuthModal(true);
  };

  // Google Sign-In with Firebase
  const handleGoogleSignIn = async () => {
    setAuthLoading(true);
    setAuthError("");
    try {
      const result = await signInWithPopup(auth, googleProvider);
      const fbUser = result.user;
      
      const profile = await createOrUpdateUserProfile(
        fbUser,
        fbUser.displayName || undefined,
        selectedPlanId
      );

      const appUser: User = {
        id: fbUser.uid,
        name: profile.displayName || fbUser.displayName || "Vault Creator",
        email: profile.email || fbUser.email || "user@cloudvalt.site",
        avatar: profile.avatarUrl || fbUser.photoURL || undefined,
        avatarFallback: `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(fbUser.email || "CV")}`,
        role: profile.role || "Visual Creator",
        plan: profile.plan || (selectedPlanId === "100mb" ? "100 MB Free (Test Mode)" : STORAGE_PLANS[selectedPlanId].name),
        planId: selectedPlanId,
        maxStorageBytes: profile.maxStorageBytes || STORAGE_PLANS[selectedPlanId].maxBytes,
        createdAt: profile.createdAt || new Date().toISOString(),
        isFirebaseUser: true,
      };

      setStoredUser(appUser);
      onLoginSuccess(appUser);
      setShowAuthModal(false);
    } catch (err: any) {
      console.error("Firebase Google Auth error:", err);
      if (err.code === "auth/popup-blocked") {
        setAuthError("Popup blocked by browser. Please use email sign-in or enable popups.");
      } else {
        setAuthError(err.message || "Failed to sign in with Google.");
      }
    } finally {
      setAuthLoading(false);
    }
  };

  // Password Reset Email via Firebase
  const handleSendForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError("");
    setAuthSuccessMsg("");
    setAuthLoading(true);

    const email = emailInput.trim();
    if (!email || !email.includes("@")) {
      setAuthError("Please enter a valid email address.");
      setAuthLoading(false);
      return;
    }

    try {
      await sendPasswordResetEmail(auth, email);
      setAuthSuccessMsg(`A password reset link has been sent to ${email}. Please check your email inbox!`);
    } catch (err: any) {
      console.error("Password reset error:", err);
      if (err.code === "auth/user-not-found") {
        setAuthError("No account found with this email address. Please click Sign Up.");
      } else if (err.code === "auth/invalid-email") {
        setAuthError("Please enter a valid email address.");
      } else {
        setAuthSuccessMsg(`Password reset instructions sent to ${email}. Check your inbox!`);
      }
    } finally {
      setAuthLoading(false);
    }
  };

  // Check Email Verification Status
  const handleCheckVerificationStatus = async () => {
    setAuthLoading(true);
    setAuthError("");
    setAuthSuccessMsg("");
    try {
      if (auth.currentUser) {
        await auth.currentUser.reload();
        if (auth.currentUser.emailVerified) {
          const fbUser = auth.currentUser;
          let profile = await fetchUserProfile(fbUser.uid);
          if (!profile) {
            profile = await createOrUpdateUserProfile(fbUser, nameInput || fbUser.displayName || undefined, selectedPlanId);
          }
          const planInfo = STORAGE_PLANS[selectedPlanId];
          const appUser: User = {
            id: fbUser.uid,
            name: profile?.displayName || nameInput || fbUser.email?.split("@")[0] || "Vault Creator",
            email: fbUser.email || emailInput,
            avatar: profile?.avatarUrl || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(fbUser.email || "CV")}`,
            role: profile?.role || "Visual Creator",
            plan: profile?.plan || (selectedPlanId === "100mb" ? "100 MB Free (Test Mode)" : planInfo.name),
            planId: selectedPlanId,
            maxStorageBytes: profile?.maxStorageBytes || planInfo.maxBytes,
            createdAt: profile?.createdAt || new Date().toISOString(),
            isFirebaseUser: true,
            emailVerified: true,
          };

          setStoredUser(appUser);
          onLoginSuccess(appUser);
          setShowAuthModal(false);
        } else {
          setAuthError(`Email (${auth.currentUser.email}) is not verified yet. Please check your inbox and click the verification link first.`);
        }
      } else {
        setAuthError("Session expired. Please log in again.");
        setAuthStep("form");
      }
    } catch (err: any) {
      setAuthError("Could not verify status. Please try again in a few moments.");
    } finally {
      setAuthLoading(false);
    }
  };

  // Resend Verification Email
  const handleResendVerificationEmail = async () => {
    setAuthLoading(true);
    setAuthError("");
    setAuthSuccessMsg("");
    try {
      if (auth.currentUser) {
        await sendEmailVerification(auth.currentUser);
        setAuthSuccessMsg(`Verification email re-sent to ${auth.currentUser.email}. Please check your inbox!`);
      } else {
        setAuthError("Please sign up or log in first.");
      }
    } catch (err: any) {
      setAuthError(err.message || "Failed to resend email. Please wait a minute and try again.");
    } finally {
      setAuthLoading(false);
    }
  };

  // Email / Password Form Submit
  const handleSubmitEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError("");
    setAuthSuccessMsg("");

    const email = emailInput.trim();
    const password = passwordInput;
    const name = nameInput.trim();

    if (!email || !email.includes("@")) {
      setAuthError("Please enter a valid email address.");
      return;
    }

    if (password.length < 6) {
      setAuthError("Password must be at least 6 characters.");
      return;
    }

    setAuthLoading(true);
    try {
      let fbUser;
      if (authMode === "signup") {
        if (!name) {
          setAuthError("Please enter your full name.");
          setAuthLoading(false);
          return;
        }
        const cred = await createUserWithEmailAndPassword(auth, email, password);
        fbUser = cred.user;
        await createOrUpdateUserProfile(fbUser, name, selectedPlanId);

        // Send email verification link and wait for user confirmation
        try {
          await sendEmailVerification(fbUser);
        } catch (vErr) {
          console.warn("Email verification dispatch notice:", vErr);
        }

        // Strictly prevent automatic login until user confirms via email link
        setStoredUser(null);
        setAuthStep("await_verification");
        setAuthSuccessMsg(`Account created! A verification link was sent to ${email}. You must click the link in your email to verify before accessing the vault.`);
        setAuthLoading(false);
        return;
      } else {
        const cred = await signInWithEmailAndPassword(auth, email, password);
        fbUser = cred.user;

        // Strict verification check on Sign In
        if (!fbUser.emailVerified) {
          try {
            await sendEmailVerification(fbUser);
          } catch {}
          setStoredUser(null);
          setAuthStep("await_verification");
          setAuthError(`Email ${email} is not verified yet. We sent a verification link to your inbox. Please click the link to confirm.`);
          setAuthLoading(false);
          return;
        }
      }

      let profile = await fetchUserProfile(fbUser.uid);
      if (!profile) {
        profile = await createOrUpdateUserProfile(fbUser, name, selectedPlanId);
      }

      const planInfo = STORAGE_PLANS[selectedPlanId];
      const appUser: User = {
        id: fbUser.uid,
        name: profile?.displayName || name || fbUser.email?.split("@")[0] || "Vault Creator",
        email: fbUser.email || email,
        avatar: profile?.avatarUrl || fbUser.photoURL || undefined,
        avatarFallback: `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(fbUser.email || "CV")}`,
        role: profile?.role || "Visual Creator",
        plan: profile?.plan || (selectedPlanId === "100mb" ? "100 MB Free (Test Mode)" : planInfo.name),
        planId: selectedPlanId,
        maxStorageBytes: profile?.maxStorageBytes || planInfo.maxBytes,
        createdAt: profile?.createdAt || new Date().toISOString(),
        isFirebaseUser: true,
        emailVerified: Boolean(fbUser.emailVerified),
      };

      setStoredUser(appUser);
      onLoginSuccess(appUser);
      setShowAuthModal(false);
    } catch (err: any) {
      console.error("Firebase Auth error:", err);
      if (err.code === "auth/email-already-in-use") {
        setAuthError("This email is already registered. Please click Log In.");
      } else if (err.code === "auth/invalid-email") {
        setAuthError("Please enter a valid email address.");
      } else if (err.code === "auth/wrong-password" || err.code === "auth/invalid-credential") {
        setAuthError("Invalid email or password.");
      } else if (err.code === "auth/weak-password") {
        setAuthError("Password should be at least 6 characters.");
      } else if (err.code === "auth/user-not-found") {
        setAuthError("No account found with this email. Please click Sign Up.");
      } else {
        setAuthError(err.message || "Failed to authenticate. Please check your credentials.");
      }
    } finally {
      setAuthLoading(false);
    }
  };



  return (
    <div className="min-h-screen bg-black text-white font-sans selection:bg-white selection:text-black flex flex-col relative overflow-x-hidden">
      {/* Background Animated Gradient Orbs */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
        <motion.div
          animate={{
            x: [0, 30, -20, 0],
            y: [0, -30, 15, 0],
            scale: [1, 1.1, 0.95, 1],
          }}
          transition={{ duration: 15, repeat: Infinity, ease: "easeInOut" }}
          className="absolute top-12 left-1/3 w-[500px] h-[350px] bg-sky-900/10 blur-[140px] rounded-full"
        />
        <motion.div
          animate={{
            x: [0, -40, 20, 0],
            y: [0, 20, -30, 0],
            scale: [1, 0.95, 1.05, 1],
          }}
          transition={{ duration: 18, repeat: Infinity, ease: "easeInOut" }}
          className="absolute top-1/4 right-1/4 w-[450px] h-[300px] bg-emerald-900/10 blur-[130px] rounded-full"
        />
      </div>

      {/* Top Navigation Bar with Generous Space */}
      <header className="sticky top-0 z-40 w-full px-4 sm:px-8 py-5">
        <div className="max-w-6xl mx-auto rounded-2xl border border-zinc-800/80 bg-black/80 backdrop-blur-xl px-6 sm:px-8 py-4 flex items-center justify-between shadow-xl shadow-black/60">
          {/* Logo */}
          <div
            className="flex items-center gap-3 cursor-pointer group"
            onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          >
            <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
              <AppLogo size={34} showWordmark={false} />
            </motion.div>
            <div className="flex flex-col">
              <span className="text-xl font-bold tracking-tight text-white leading-none">
                Cloudvalt
              </span>
              <span className="text-[10px] text-zinc-500 font-medium tracking-wide mt-0.5">
                Photos & 4K Video Vault
              </span>
            </div>
          </div>

          {/* Navigation Links */}
          <nav className="hidden md:flex items-center gap-8 text-sm font-medium text-zinc-400">
            <a href="#about" className="hover:text-white transition-colors">About</a>
            <a href="#faq" className="hover:text-white transition-colors">FAQ</a>
            <a href="#pricing" className="hover:text-white transition-colors flex items-center gap-1.5">
              <span>Plans</span>
              <span className="px-2 py-0.5 text-[10px] rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-semibold">
                From $3.99
              </span>
            </a>
            <a href="#test-mode" className="hover:text-white transition-colors">
              100 MB Test Mode
            </a>
            <a href="#security" className="hover:text-white transition-colors">
              Security
            </a>
          </nav>

          {/* Right Action Buttons */}
          <div className="flex items-center gap-2.5">
            {currentUser && currentUser.emailVerified !== false ? (
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={onEnterVault}
                className="bg-white text-black hover:bg-zinc-200 font-bold text-xs sm:text-sm px-4 py-2 rounded-xl transition-all flex items-center gap-1.5 shadow-md shadow-white/10"
              >
                <span>Open Vault</span>
                <ArrowRight className="h-4 w-4" />
              </motion.button>
            ) : (
              <>
                <motion.button
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => handleOpenAuth("signup", "100mb")}
                  className="bg-white text-black hover:bg-zinc-200 font-bold text-xs sm:text-sm px-4 py-2 rounded-xl transition-all shadow-md shadow-white/10 flex items-center gap-1.5"
                >
                  <Sparkles className="h-3.5 w-3.5 text-black" />
                  <span>Free Test Mode</span>
                </motion.button>
                <button
                  type="button"
                  onClick={() => handleOpenAuth("signin")}
                  className="text-zinc-300 hover:text-white font-medium text-xs sm:text-sm px-3 py-1.5 rounded-lg transition-colors hover:bg-zinc-900"
                >
                  Log In
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Hero Section with Generous Breathing Room */}
      <section className="relative z-10 pt-16 sm:pt-24 pb-16 sm:pb-24 px-6 text-center">
        <div className="max-w-4xl mx-auto">
          {/* Anti-Spam Badge */}
          <motion.div
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-zinc-900 border border-zinc-800 text-xs font-semibold text-zinc-300 mb-6"
          >
            <span className="flex h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>Lossless Photos & 4K Videos</span>
            <span className="text-zinc-600">·</span>
            <span className="text-emerald-400 font-mono">100 MB Free Test Mode</span>
          </motion.div>

          {/* Main Headline */}
          <motion.h1
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="text-4xl sm:text-6xl font-black tracking-tight text-white leading-[1.08]"
          >
            Your Photos & 4K Videos,{" "}
            <span className="bg-gradient-to-r from-white via-zinc-200 to-zinc-400 bg-clip-text text-transparent underline decoration-zinc-700 underline-offset-8">
              Safely in the Vault
            </span>
          </motion.h1>

          {/* Subtitle */}
          <motion.p
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.18 }}
            className="mt-6 text-base sm:text-lg text-zinc-400 max-w-2xl mx-auto leading-relaxed"
          >
            Zero compression. Preserve camera RAW photos and stream 4K video clips seamlessly. Start in <strong className="text-white">100 MB Free Test Mode</strong> to verify upload speeds, then expand up to 1 TB.
          </motion.p>

          {/* Anti-spam notice */}
          <div id="test-mode" className="mt-5 inline-flex items-center gap-2 px-3.5 py-1.5 rounded-xl bg-zinc-900/60 border border-zinc-800 text-xs text-zinc-400">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
            <span>100 MB test mode prevents bot account spam while letting you test real uploads risk-free.</span>
          </div>

          {/* CTA Buttons */}
          <motion.div
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.25 }}
            className="mt-8 flex flex-wrap items-center justify-center gap-3.5"
          >
            {currentUser && currentUser.emailVerified !== false ? (
              <motion.button
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                onClick={onEnterVault}
                className="bg-white text-black hover:bg-zinc-200 font-bold text-sm px-7 py-3 rounded-xl transition-all shadow-lg shadow-white/10 flex items-center gap-2"
              >
                <span>Enter Your Vault</span>
                <ArrowRight className="h-4 w-4" />
              </motion.button>
            ) : (
              <>
                <motion.button
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => handleOpenAuth("signup", "100mb")}
                  className="bg-white text-black hover:bg-zinc-200 font-bold text-sm px-6 py-3 rounded-xl transition-all shadow-lg shadow-white/10 flex items-center gap-2"
                >
                  <Sparkles className="h-4 w-4 text-black" />
                  <span>Start 100 MB Test Free</span>
                </motion.button>
                <a
                  href="#pricing"
                  className="border border-zinc-800 bg-zinc-950 hover:bg-zinc-900 text-zinc-300 hover:text-white font-medium text-sm px-5 py-3 rounded-xl transition-all flex items-center gap-2"
                >
                  <Flame className="h-4 w-4 text-amber-400" />
                  <span>View Plans (From $3.99)</span>
                </a>
              </>
            )}
          </motion.div>
        </div>
      </section>

      {/* About Cloudvalt */}
      <section id="about" className="relative z-10 border-t border-zinc-900 bg-zinc-950/50 px-6 py-16 sm:py-20 scroll-mt-24">
        <div className="mx-auto grid max-w-6xl gap-10 md:grid-cols-[1.1fr_0.9fr] md:items-center">
          <div>
            <span className="text-xs font-bold uppercase tracking-wider text-emerald-400">About Cloudvalt</span>
            <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
              A calmer home for your creative work.
            </h2>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-zinc-400 sm:text-base">
              Cloudvalt is a cloud vault for photographers, videographers, and anyone with a growing collection of important files. Upload your originals, organize them into folders, preview supported media, and keep an eye on how much storage you have used.
            </p>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-zinc-400 sm:text-base">
              Start with a free 100 MB test account to try the upload and library experience. When you need more room, choose a larger storage plan from your account.
            </p>
            <a href="#pricing" className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-white hover:text-emerald-300">
              Explore storage plans <ArrowRight className="h-4 w-4" />
            </a>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-zinc-800 bg-black/60 p-5">
              <UploadCloud className="h-5 w-5 text-emerald-400" />
              <h3 className="mt-4 text-sm font-bold text-white">Upload your originals</h3>
              <p className="mt-2 text-xs leading-6 text-zinc-400">Keep your photos, videos, and other files together in one library.</p>
            </div>
            <div className="rounded-2xl border border-zinc-800 bg-black/60 p-5">
              <HardDrive className="h-5 w-5 text-sky-400" />
              <h3 className="mt-4 text-sm font-bold text-white">Know what you have</h3>
              <p className="mt-2 text-xs leading-6 text-zinc-400">See your storage use and remaining space as your collection grows.</p>
            </div>
            <div className="rounded-2xl border border-zinc-800 bg-black/60 p-5 sm:col-span-2">
              <ImageIcon className="h-5 w-5 text-purple-400" />
              <h3 className="mt-4 text-sm font-bold text-white">Keep work organized</h3>
              <p className="mt-2 text-xs leading-6 text-zinc-400">Create folders for projects, browse by file type, and find your saved media again when you need it.</p>
            </div>
          </div>
        </div>
      </section>

      {/* PRICING PLANS SECTION (Clean & Direct) */}
      <section id="pricing" className="py-20 border-t border-zinc-900 relative z-10 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="text-center max-w-2xl mx-auto mb-14">
            <span className="text-xs uppercase font-bold text-amber-400 tracking-wider">
              High Capacity Storage
            </span>
            <h2 className="text-3xl sm:text-4xl font-extrabold text-white mt-2">
              Transparent Plans for Photographers & Videographers
            </h2>
            <p className="text-sm text-zinc-400 mt-2">
              Start with 100 MB test mode for anti-spam testing, then upgrade whenever your portfolio expands.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            {/* 100 MB Free (Test Mode) */}
            <motion.div
              whileHover={{ y: -4 }}
              className="p-6 rounded-2xl border border-zinc-800 bg-zinc-950 flex flex-col justify-between"
            >
              <div>
                <span className="text-[10px] uppercase font-bold text-emerald-400 bg-emerald-500/10 px-2.5 py-0.5 rounded border border-emerald-500/20">
                  Anti-Spam Trial
                </span>
                <h3 className="text-xl font-bold text-white mt-3">100 MB Free</h3>
                <p className="text-xs text-zinc-400 mt-1">Test mode to verify lossless photo & video speeds.</p>
                <div className="my-4 text-3xl font-extrabold text-white">
                  $0 <span className="text-xs text-zinc-500 font-normal">/ forever</span>
                </div>
                <div className="space-y-2 text-xs text-zinc-400 border-t border-zinc-800/80 pt-3">
                  <div className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-emerald-400" /><span>100 MB lossless storage</span></div>
                  <div className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-emerald-400" /><span>No credit card required</span></div>
                  <div className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-emerald-400" /><span>Prevents bot spam</span></div>
                </div>
              </div>
              <button
                onClick={() => handleOpenAuth("signup", "100mb")}
                className="mt-6 w-full bg-zinc-900 hover:bg-zinc-800 text-white border border-zinc-700 font-semibold text-xs py-2.5 rounded-xl transition-all"
              >
                Start Free Test
              </button>
            </motion.div>

            {/* 50 GB for $3.99 */}
            <motion.div
              whileHover={{ y: -4 }}
              className="p-6 rounded-2xl border border-zinc-800 bg-zinc-950 flex flex-col justify-between"
            >
              <div>
                <span className="text-[10px] uppercase font-bold text-sky-400 bg-sky-500/10 px-2.5 py-0.5 rounded border border-sky-500/20">
                  Creator Starter
                </span>
                <h3 className="text-xl font-bold text-white mt-3">50 GB</h3>
                <p className="text-xs text-zinc-400 mt-1">~12,500 high-res photos or 10 hours 1080p video.</p>
                <div className="my-4 text-3xl font-extrabold text-white">
                  $3.99 <span className="text-xs text-zinc-500 font-normal">/ mo</span>
                </div>
                <div className="space-y-2 text-xs text-zinc-400 border-t border-zinc-800/80 pt-3">
                  <div className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-sky-400" /><span>50 GB cloud quota</span></div>
                  <div className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-sky-400" /><span>4K video streaming</span></div>
                  <div className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-sky-400" /><span>Direct RAW downloads</span></div>
                </div>
              </div>
              <button
                onClick={() => window.open(STORAGE_PLANS["50gb"].checkoutUrl, "_blank", "noopener,noreferrer")}
                className="mt-6 w-full bg-white text-black hover:bg-zinc-200 font-bold text-xs py-2.5 rounded-xl transition-all shadow-md shadow-white/5"
              >
                Get 50 GB ($3.99)
              </button>
            </motion.div>

            {/* 250 GB for $6.99 (Featured) */}
            <motion.div
              whileHover={{ y: -6 }}
              className="p-6 rounded-2xl border-2 border-emerald-500 bg-gradient-to-b from-zinc-900 to-zinc-950 flex flex-col justify-between relative shadow-xl shadow-emerald-500/10"
            >
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full bg-emerald-500 text-black text-[10px] font-extrabold uppercase tracking-wider">
                Most Popular
              </div>
              <div>
                <span className="text-[10px] uppercase font-bold text-emerald-400 bg-emerald-500/20 px-2.5 py-0.5 rounded border border-emerald-500/30">
                  Pro Studio
                </span>
                <h3 className="text-xl font-bold text-white mt-3">250 GB</h3>
                <p className="text-xs text-zinc-400 mt-1">~62,500 photos or 50 hours 4K video clips.</p>
                <div className="my-4 text-3xl font-extrabold text-white">
                  $6.99 <span className="text-xs text-zinc-500 font-normal">/ mo</span>
                </div>
                <div className="space-y-2 text-xs text-zinc-400 border-t border-zinc-800/80 pt-3">
                  <div className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-emerald-400" /><span>250 GB capacity</span></div>
                  <div className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-emerald-400" /><span>Batch ZIP exports</span></div>
                  <div className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-emerald-400" /><span>Priority cloud bandwidth</span></div>
                </div>
              </div>
              <button
                onClick={() => window.open(STORAGE_PLANS["250gb"].checkoutUrl, "_blank", "noopener,noreferrer")}
                className="mt-6 w-full bg-emerald-400 hover:bg-emerald-300 text-black font-extrabold text-xs py-2.5 rounded-xl transition-all shadow-md shadow-emerald-400/20"
              >
                Get 250 GB ($6.99)
              </button>
            </motion.div>

            {/* 1 TB for $13.99 */}
            <motion.div
              whileHover={{ y: -4 }}
              className="p-6 rounded-2xl border border-zinc-800 bg-zinc-950 flex flex-col justify-between"
            >
              <div>
                <span className="text-[10px] uppercase font-bold text-purple-400 bg-purple-500/10 px-2.5 py-0.5 rounded border border-purple-500/20">
                  Ultimate Vault
                </span>
                <h3 className="text-xl font-bold text-white mt-3">1 TB</h3>
                <p className="text-xs text-zinc-400 mt-1">1,000 GB storage for complete commercial studios.</p>
                <div className="my-4 text-3xl font-extrabold text-white">
                  $13.99 <span className="text-xs text-zinc-500 font-normal">/ mo</span>
                </div>
                <div className="space-y-2 text-xs text-zinc-400 border-t border-zinc-800/80 pt-3">
                  <div className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-purple-400" /><span>1,000 GB capacity</span></div>
                  <div className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-purple-400" /><span>Global CDN priority</span></div>
                  <div className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-purple-400" /><span>VIP creator support</span></div>
                </div>
              </div>
              <button
                onClick={() => window.open(STORAGE_PLANS["1tb"].checkoutUrl, "_blank", "noopener,noreferrer")}
                className="mt-6 w-full bg-white text-black hover:bg-zinc-200 font-bold text-xs py-2.5 rounded-xl transition-all"
              >
                Get 1 TB ($13.99)
              </button>
            </motion.div>
            <motion.div className="p-6 rounded-2xl border border-dashed border-zinc-700 bg-zinc-950/60 flex flex-col justify-center">
              <span className="text-[10px] uppercase font-bold text-amber-400">Coming Soon</span>
              <h3 className="text-xl font-bold text-white mt-3">2 TB</h3>
              <p className="text-xs text-zinc-400 mt-1">More room for growing creator libraries.</p>
              <div className="my-4 text-lg font-bold text-zinc-500">Coming soon</div>
            </motion.div>
          </div>
        </div>
      </section>

      {/* Frequently Asked Questions */}
      <section id="faq" className="relative z-10 border-t border-zinc-900 bg-black px-6 py-16 sm:py-20 scroll-mt-24">
        <div className="mx-auto max-w-3xl">
          <div className="mb-10 text-center">
            <span className="text-xs font-bold uppercase tracking-wider text-emerald-400">Quick answers</span>
            <h2 className="mt-2 text-3xl font-extrabold tracking-tight text-white sm:text-4xl">Frequently asked questions</h2>
            <p className="mt-3 text-sm text-zinc-400">A few details about storing and managing your files with Cloudvalt.</p>
          </div>
          <div className="space-y-3">
            {[
              {
                question: "What is Cloudvalt?",
                answer: "Cloudvalt is an online library for photos, videos, and other files. You can upload, preview supported media, organize files into folders, and track your storage use.",
              },
              {
                question: "Will Cloudvalt change or compress my uploaded files?",
                answer: "Uploads are stored as the original file. The app may create a small preview thumbnail for display, but that thumbnail does not replace the original.",
              },
              {
                question: "How do folders work?",
                answer: "Folders help organize files in your library. Each folder shows the combined size of the files it contains, including nested folders.",
              },
              {
                question: "What happens when I delete a file?",
                answer: "Deleted files move to Trash, where you can restore them. They are permanently removed after 30 days; you can also permanently delete them yourself at any time.",
              },
              {
                question: "What does the free plan include?",
                answer: "The free test mode includes up to 100 MB so you can try the upload and library experience. The app displays your used and remaining storage in the vault.",
              },
              {
                question: "Can I buy a paid storage plan here?",
                answer: "Paid plans open checkout and charge the listed price every 30 days, with no extra first payment charge. Storage upgrades are applied after payment confirmation is connected to your account.",
              },
            ].map((item) => (
              <details key={item.question} className="group rounded-2xl border border-zinc-800 bg-zinc-950 px-5 open:border-zinc-700">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-sm font-semibold text-white marker:content-none [&::-webkit-details-marker]:hidden">
                  {item.question}
                  <ChevronRight className="h-4 w-4 shrink-0 text-zinc-500 transition-transform group-open:rotate-90" />
                </summary>
                <p className="max-w-2xl pb-5 pr-8 text-sm leading-6 text-zinc-400">{item.answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* Security & Account Sync Callout */}
      <section id="security" className="py-14 border-t border-zinc-900 bg-black px-6 text-center text-xs text-zinc-500">
        <div className="max-w-3xl mx-auto flex flex-wrap items-center justify-center gap-6">
          <div className="flex items-center gap-1.5 text-zinc-400">
            <Lock className="h-3.5 w-3.5 text-emerald-400" />
            <span>AES-256 Vault Encryption</span>
          </div>
          <div className="flex items-center gap-1.5 text-zinc-400">
            <Database className="h-3.5 w-3.5 text-sky-400" />
            <span>Account & Library Synced</span>
          </div>
          <div className="flex items-center gap-1.5 text-zinc-400">
            <ShieldCheck className="h-3.5 w-3.5 text-purple-400" />
            <span>Anti-Bot Spam Protection</span>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-zinc-900 py-6 px-6 text-[11px] text-zinc-500 bg-black">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <AppLogo size={18} showWordmark={false} />
            <span className="font-semibold text-zinc-300">Cloudvalt</span>
            <span>· Photos & Videos Cloud Storage</span>
          </div>
          <div className="flex items-center gap-4">
            <span>100 MB Test Mode</span>
            <span>50 GB · 250 GB · 1 TB</span>
            <span>© {new Date().getFullYear()} Cloudvalt</span>
          </div>
        </div>
      </footer>

      {/* COMPACT AUTH MODAL (Real Auth, No Fake Sandbox) */}
      <AnimatePresence>
        {showAuthModal && (
          <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.15 }}
              className="bg-zinc-950 border border-zinc-800 rounded-2xl max-w-[340px] w-full p-5 shadow-2xl relative"
            >
              {/* Close Button */}
              <button
                onClick={() => setShowAuthModal(false)}
                className="absolute top-4 right-4 text-zinc-400 hover:text-white p-1 rounded-lg hover:bg-zinc-900"
              >
                <X className="h-4 w-4" />
              </button>

              {/* Header */}
              <div className="text-center mb-4">
                <AppLogo size={28} showWordmark={false} className="mx-auto mb-1.5" />
                <h3 className="text-lg font-bold text-white">
                  {authStep === "forgot"
                    ? "Forgot Password"
                    : authStep === "await_verification"
                    ? "Verify Your Email"
                    : authMode === "signin"
                    ? "Log In to Cloudvalt"
                    : "Create Account"}
                </h3>
                <span className="text-[11px] text-zinc-400 block mt-0.5">
                  {authStep === "forgot"
                    ? "Enter your email to receive a password reset link"
                    : authStep === "await_verification"
                    ? "Confirm email verification to access your vault"
                    : authMode === "signin"
                    ? "Access your photo & video vault"
                    : `Plan: ${STORAGE_PLANS[selectedPlanId].name}`}
                </span>
              </div>

              {/* Tabs (only in normal form step) */}
              {authStep === "form" && (
                <div className="flex rounded-lg bg-zinc-900 p-0.5 mb-3.5 border border-zinc-800 text-xs">
                  <button
                    type="button"
                    onClick={() => {
                      setAuthMode("signup");
                      setAuthError("");
                      setAuthSuccessMsg("");
                    }}
                    className={`flex-1 py-1.5 font-semibold rounded-md transition-colors ${
                      authMode === "signup" ? "bg-white text-black shadow-sm" : "text-zinc-400 hover:text-white"
                    }`}
                  >
                    Sign Up
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAuthMode("signin");
                      setAuthError("");
                      setAuthSuccessMsg("");
                    }}
                    className={`flex-1 py-1.5 font-semibold rounded-md transition-colors ${
                      authMode === "signin" ? "bg-white text-black shadow-sm" : "text-zinc-400 hover:text-white"
                    }`}
                  >
                    Log In
                  </button>
                </div>
              )}

              {/* Success Message Banner */}
              {authSuccessMsg && (
                <div className="mb-3 p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[11px] flex items-center gap-1.5 leading-relaxed">
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                  <span>{authSuccessMsg}</span>
                </div>
              )}

              {/* Error Banner */}
              {authError && (
                <div className="mb-3 p-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-[11px] flex items-center gap-1.5 leading-relaxed">
                  <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
                  <span>{authError}</span>
                </div>
              )}

              {/* VIEW 1: FORGOT PASSWORD */}
              {authStep === "forgot" && (
                <form onSubmit={handleSendForgotPassword} className="space-y-3">
                  <div className="relative">
                    <Mail className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                    <input
                      type="email"
                      required
                      value={emailInput}
                      onChange={(e) => setEmailInput(e.target.value)}
                      placeholder="Your Registered Email"
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-xl pl-9 pr-3 py-2 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-white transition-colors"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={authLoading}
                    className="w-full bg-white text-black hover:bg-zinc-200 font-bold text-xs py-2.5 rounded-xl transition-all shadow-sm disabled:opacity-50 flex items-center justify-center gap-1.5 mt-1"
                  >
                    {authLoading ? (
                      <div className="h-3.5 w-3.5 border-2 border-black border-t-transparent animate-spin rounded-full" />
                    ) : (
                      <KeyRound className="h-3.5 w-3.5 text-black" />
                    )}
                    <span>Send Password Reset Email</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setAuthStep("form");
                      setAuthError("");
                      setAuthSuccessMsg("");
                    }}
                    className="w-full text-center text-xs text-zinc-400 hover:text-white pt-1 flex items-center justify-center gap-1"
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    <span>Back to Log In</span>
                  </button>
                </form>
              )}
              {/* VIEW 2: AWAIT EMAIL VERIFICATION */}
              {authStep === "await_verification" && (
                <div className="space-y-3.5">
                  <div className="p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs leading-relaxed flex items-start gap-2.5 text-left">
                    <Mail className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
                    <div>
                      <strong className="block text-white font-semibold mb-0.5">Verification Link Sent!</strong>
                      <span>
                        We sent a verification link to <strong className="text-amber-200 underline">{emailInput || auth.currentUser?.email}</strong>. Please open your inbox or spam folder and click the link to confirm your account.
                      </span>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={handleCheckVerificationStatus}
                    disabled={authLoading}
                    className="w-full bg-emerald-400 hover:bg-emerald-300 text-black font-extrabold text-xs py-2.5 rounded-xl transition-all shadow-md shadow-emerald-400/20 disabled:opacity-50 flex items-center justify-center gap-1.5"
                  >
                    {authLoading ? (
                      <div className="h-3.5 w-3.5 border-2 border-black border-t-transparent animate-spin rounded-full" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4 text-black" />
                    )}
                    <span>I've Verified My Email — Access Vault</span>
                  </button>

                  <div className="flex items-center justify-between text-[11px] text-zinc-400 pt-1">
                    <button
                      type="button"
                      onClick={handleResendVerificationEmail}
                      disabled={authLoading}
                      className="hover:text-white flex items-center gap-1 transition-colors"
                    >
                      <RefreshCw className="h-3 w-3" />
                      <span>Resend Email</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setAuthStep("form");
                        setAuthError("");
                        setAuthSuccessMsg("");
                      }}
                      className="hover:text-white flex items-center gap-1 transition-colors"
                    >
                      <ArrowLeft className="h-3 w-3" />
                      <span>Back to Log In</span>
                    </button>
                  </div>
                </div>
              )}

              {/* VIEW 3: STANDARD FORM (SIGN UP / SIGN IN) */}
              {authStep === "form" && (
                <>
                  {/* Google Button */}
                  <button
                    type="button"
                    onClick={handleGoogleSignIn}
                    disabled={authLoading}
                    className="w-full mb-3 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-white font-medium text-xs py-2 px-3 rounded-xl transition-all flex items-center justify-center gap-2"
                  >
                    <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24">
                      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
                      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
                    </svg>
                    <span>Continue with Google</span>
                  </button>

                  <div className="relative flex items-center justify-center my-2.5">
                    <div className="w-full border-t border-zinc-800" />
                    <span className="bg-zinc-950 px-2 text-[9px] text-zinc-500 uppercase font-semibold">Or Email</span>
                  </div>

                  <form onSubmit={handleSubmitEmailAuth} className="space-y-3">
                    {authMode === "signup" && (
                      <>
                        <div>
                          <label className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 block mb-1">
                            Select Storage Plan
                          </label>
                          <div className="grid grid-cols-4 gap-1.5 mb-2">
                            {(["100mb", "50gb", "250gb", "1tb"] as const).map((pid) => {
                              const p = STORAGE_PLANS[pid];
                              const isSel = selectedPlanId === pid;
                              return (
                                <button
                                  key={pid}
                                  type="button"
                                  onClick={() => setSelectedPlanId(pid)}
                                  className={`px-1.5 py-1.5 rounded-lg text-center transition-all border text-[11px] flex flex-col items-center justify-center ${
                                    isSel
                                      ? "bg-white text-black border-white font-bold shadow-sm"
                                      : "bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-white"
                                  }`}
                                >
                                  <span className="leading-tight">{p.name.split(" ")[0]}</span>
                                  <span className={`text-[9px] ${isSel ? "text-zinc-700 font-semibold" : "text-zinc-500"}`}>
                                    {p.priceFormatted}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        <div className="relative">
                          <UserIcon className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                          <input
                            type="text"
                            required
                            value={nameInput}
                            onChange={(e) => setNameInput(e.target.value)}
                            placeholder="Your Full Name"
                            className="w-full bg-zinc-900 border border-zinc-800 rounded-xl pl-9 pr-3 py-2 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-white transition-colors"
                          />
                        </div>
                      </>
                    )}

                    <div className="relative">
                      <Mail className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                      <input
                        type="email"
                        required
                        value={emailInput}
                        onChange={(e) => setEmailInput(e.target.value)}
                        placeholder="Email Address"
                        className="w-full bg-zinc-900 border border-zinc-800 rounded-xl pl-9 pr-3 py-2 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-white transition-colors"
                      />
                    </div>

                    <div className="space-y-1">
                      <div className="relative">
                        <Lock className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                        <input
                          type={showModalPassword ? "text" : "password"}
                          required
                          value={passwordInput}
                          onChange={(e) => setPasswordInput(e.target.value)}
                          placeholder="Password (minimum 6 characters)"
                          className="w-full bg-zinc-900 border border-zinc-800 rounded-xl pl-9 pr-10 py-2 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-white transition-colors"
                        />
                        <button
                          type="button"
                          onClick={() => setShowModalPassword(!showModalPassword)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-white"
                          tabIndex={-1}
                        >
                          {showModalPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        </button>
                      </div>

                      {authMode === "signin" && (
                        <div className="flex justify-end pt-0.5">
                          <button
                            type="button"
                            onClick={() => {
                              setAuthStep("forgot");
                              setAuthError("");
                              setAuthSuccessMsg("");
                            }}
                            className="text-[11px] text-zinc-400 hover:text-white hover:underline transition-colors"
                          >
                            Forgot Password?
                          </button>
                        </div>
                      )}
                    </div>

                    <button
                      type="submit"
                      disabled={authLoading}
                      className="w-full bg-white text-black hover:bg-zinc-200 font-bold text-xs py-2.5 rounded-xl transition-all shadow-sm disabled:opacity-50 flex items-center justify-center gap-1.5 mt-1"
                    >
                      {authLoading ? (
                        <div className="h-3.5 w-3.5 border-2 border-black border-t-transparent animate-spin rounded-full" />
                      ) : (
                        <Mail className="h-3.5 w-3.5 text-black" />
                      )}
                      <span>
                        {authMode === "signin"
                          ? "Log In"
                          : "Sign Up & Verify Email"}
                      </span>
                    </button>
                  </form>
                </>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
