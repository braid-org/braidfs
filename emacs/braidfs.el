(provide 'braidfs)

(require 'benchmark)

(defun find-executable (executable)
  (let* ((extra-paths (shell-command-to-string 
                       (format "%s -c 'echo $PATH'" (or (getenv "SHELL") "/bin/sh"))))
         (exec-path (append (split-string extra-paths ":") exec-path)))
    (executable-find executable)))

;; You can customize this with M-x customize-variable RET braidfs-binary-location
(defcustom braidfs-node-location (find-executable "node")
  "Location for bin/node on your filesystem"
  :type 'string
  :group 'braidfs)

(defcustom braidfs-binary-location (find-executable "braidfs")
  "Location for bin/braidfs on your filesystem"
  :type 'string
  :group 'braidfs)

(defvar-local braidfs-last-saved-version nil
  "The version status of the file being edited with braidfs.
Can be:
- nil: Not tracking with braidfs
- symbol: Process started but waiting for completion
- string: The version of the file before editing")

(defvar-local braidfs-editor-process nil
  "Short-lived process for the async braidfs editing commands.")

;; Define a predicate to check if file is in ~/http directory and doesn't contain #
(defun braidfs-file-in-http-dir-p (&optional filename)
  "Check if FILENAME is within the ~/http directory and doesn't contain #."
  (let ((filename (or filename (buffer-file-name))))
    (and filename
         (string-prefix-p (expand-file-name "~/http/")
                          (expand-file-name filename))
         (not (string-match-p "#" filename)))))

;; Function to run before changes occur
(defun braidfs-before-change-function (begin end)
  "Notice when the buffer is first modified"
  (when (and (braidfs-file-in-http-dir-p)
             ;; Only run it the first time the buffer is modified
             (not braidfs-last-saved-version))
    ;; (message "Starting edit on file in ~/http: %s" filename)
    
    ;; Mark that we're waiting for the process to complete
    (setq braidfs-last-saved-version 'waiting)
    
    (let* ((program "braidfs")
           (args (list "editing" (expand-file-name (buffer-file-name))))
           (process-buffer (generate-new-buffer " *braidfs-edit*")))
      
      ;; Start the async process
      (setq braidfs-editor-process
            (make-process
             :name "braidfs-edit"
             :buffer process-buffer
             :connection-type 'pipe
             :command (cons program args)
             :sentinel (lambda (proc event)
                         (when (not (process-live-p proc))
                           (let ((exit-code (process-exit-status proc))
                                 (output (with-current-buffer (process-buffer proc)
                                           (buffer-string)))
                                 (target-buffer (process-get proc 'target-buffer)))
                             (when (buffer-live-p target-buffer)
                               (with-current-buffer target-buffer
                                 ;; Only update if this is still the active process
                                 (when (eq proc braidfs-editor-process)
                                   (setq braidfs-last-saved-version (if (= exit-code 0) output 'error))))))
                           ;; Clean up the process buffer
                           (kill-buffer (process-buffer proc))))))
      
      ;; Store the target buffer as a process property
      (process-put braidfs-editor-process 'target-buffer (current-buffer))
      
      ;; Send the current buffer content to the process
      (set-process-coding-system braidfs-editor-process 'utf-8 'utf-8)
      (process-send-string braidfs-editor-process (buffer-string))
      (process-send-eof braidfs-editor-process))))

(defun braidfs-handling-save-p ()
  (and (braidfs-file-in-http-dir-p)
       braidfs-last-saved-version))

;; Function to handle saving files through the normal mechanism
(defun braidfs-write-file-hook ()
  "Hook that runs when saving files. Use normal save mechanism but handle braidfs files specially."
  (if (not (braidfs-handling-save-p))
      nil  ; Not handling this file, return nil to allow normal processing
    
    ;; Handle waiting for async process
    (when (eq braidfs-last-saved-version 'waiting)
      (message "Waiting for braidfs to finish processing...")
      (while (eq braidfs-last-saved-version 'waiting)
        (sit-for 0.03)))
    
    ;; Check if there was an error in the async process
    (if (not (stringp braidfs-last-saved-version))
        (progn
          (message "braidfs failed to merge: saving normally")
          nil)  ;; Return nil to allow normal save mechanism
      
      ;; Call "braidfs edited" with the parent version and new content
      (let* ((program "braidfs")
             (args (list "edited"
                         (expand-file-name (buffer-file-name))
                         braidfs-last-saved-version))
             (exit-code nil)
             (buffer (current-buffer))
             (output ""))
        
      ;; Run the process and capture output
      (with-temp-buffer
        (message
         "`braidfs edited` took %s"
         (car
          (benchmark-run
              (progn
                (insert-buffer-substring buffer)
                (setq exit-code
                      (apply 'call-process-region
                             (point-min) (point-max)
                             program
                             t            ; delete region
                             (list t nil) ; output to current buffer, no stderr
                             nil          ; don't redisplay during output
                             args))
                (setq output (buffer-string))
                (message "`braidfs edited` returned: %s (exit code: %d)"
                         (string-trim output)
                         exit-code))))))
        
        ;; If the command was successful then...
        (if (= exit-code 0)
            (progn
              ;; Reload the file
              (let ((inhibit-message t))
                (revert-buffer t t t))
              
              ;; Reset braidfs tracking
              (setq braidfs-last-saved-version nil)
              
              ;; Return t to tell emacs that we handled saving the file
              t)
          ;; If command failed, return nil to allow normal save
          nil)))))

;; Reset the braidfs state when a file is opened
(defun braidfs-reset-state ()
  (when (braidfs-file-in-http-dir-p)
    (unless (file-exists-p (buffer-file-name))
      (braidfs-sync-file (buffer-file-name)))
    (setq braidfs-last-saved-version nil)
    (message "Reset braidfs state for: %s" (buffer-file-name))))

(defun braidfs-sync-file (&optional filename)
  (interactive)
  (setq filename (or filename (buffer-file-name)))
  (shell-command (concat "braidfs sync "
                         (replace-regexp-in-string "^/home/[^/]+/http/"
                                                   "https://"
                                                   filename))))

(defun braidfs-unsync-file (&optional filename)
  (interactive)
  (setq filename (or filename (buffer-file-name)))
  (shell-command (concat "braidfs unsync "
                         (replace-regexp-in-string "^/home/[^/]+/http/"
                                                   "https://"
                                                   filename))))

(defun braidfs-post-command-hook ()
  "Check if we did undo back to an unmodified buffer.  If so, check for reload."
  (when (and (braidfs-file-in-http-dir-p)
             braidfs-last-saved-version    ;; Buffer is being edited with braidfs
             (not (buffer-modified-p))     ;; Buffer is no longer modified
             (eq this-command 'undo))      ;; Last command was undo

    ;; Reset braidfs tracking
    (setq braidfs-last-saved-version nil)
    ;; Reload the file to ensure sync with server
    (let ((inhibit-message t))
      (revert-buffer t t t))))

(defun braidfs-around-save-buffer-advice (original-fun &rest args)
  "Advice to clear file modification time before saving if using braidfs."
  (if braidfs-last-saved-version (clear-visited-file-modtime))
  (apply original-fun args))

(defvar braidfs-previous-autorevert-value nil)
(defun braidfs-enable-collab ()
  "Enables conflict-free collaborative editing in emacs over braidfs."
  (interactive)

  ;; Add hooks and advice
  (add-hook 'before-change-functions 'braidfs-before-change-function)
  (add-hook 'find-file-hook 'braidfs-reset-state)
  (add-hook 'write-file-functions 'braidfs-write-file-hook)
  (add-hook 'post-command-hook 'braidfs-post-command-hook)
  (advice-add 'save-buffer :around #'braidfs-around-save-buffer-advice)

  (setq braidfs-previous-autorevert-value global-auto-revert-mode)
  (global-auto-revert-mode 1))

(defun braidfs-disable-collab ()
  "Disables conflict-free collaborative editing in emacs over braidfs."
  (interactive)

  ;; Remove hooks and advice
  (remove-hook 'before-change-functions 'braidfs-before-change-function)
  (remove-hook 'find-file-hook 'braidfs-reset-state)
  (remove-hook 'write-file-functions 'braidfs-write-file-hook)
  (remove-hook 'post-command-hook 'braidfs-post-command-hook)
  (advice-remove 'save-buffer #'braidfs-around-save-buffer-advice)

  (global-auto-revert-mode
   ;; It enables if we pass nil, and disables if we pass a negative number
   (if braidfs-previous-autorevert-value nil -1)))


;; Love news feed.  Love news feed.  Love news feed.
;; https://x.com/toomim/status/1901508275528487348


(braidfs-enable-collab)
