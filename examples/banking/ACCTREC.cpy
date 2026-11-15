      *----------------------------------------------------------------
      * ACCTREC : SAVINGS ACCOUNT RECORD (TABLE ACCOUNTS)
      * MUE EXAMPLE - FICTIONAL SYSTEM
      *----------------------------------------------------------------
       01  ACCT-REC.
      *    INTERNAL ACCOUNT NUMBER
           05  ACCT-NUMBER         PIC X(11).
      *    STATUS : A = ACTIVE, B = BLOCKED, C = CLOSED
           05  ACCT-STATUS         PIC X.
               88  ACCT-ACTIVE     VALUE 'A'.
               88  ACCT-BLOCKED    VALUE 'B'.
               88  ACCT-CLOSED     VALUE 'C'.
      *    AVERAGE BALANCE OVER THE PERIOD
           05  ACCT-BALANCE        PIC S9(11)V99 COMP-3.
      *    ANNUAL RATE AS A PERCENTAGE (E.G. 2.5000)
           05  ACCT-RATE           PIC 9(3)V9(4) COMP-3.
